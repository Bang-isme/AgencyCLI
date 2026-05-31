# Agency CLI — Core Engine (Harness)

## Overview

The Core Engine (`packages/core/`) is the central orchestration kernel. It handles prompt routing, LLM chat orchestration, task planning & execution, agent dispatch, workflow composition, context management, approval & security gating, and event streaming. Every CLI command and TUI action flows through this layer.

---

## 1. Prompt Routing System

**Location:** `packages/core/src/router/`

### Architecture

```
User Prompt
    │
    ▼
routeUserPrompt()          [model-router.ts]
    │
    ├─→ routePrompt()      [prompt-bridge.ts]
    │     └─→ Python prompt_router.py (skills pack)
    │         └─→ execa(python3|python|py, [".system/scripts/prompt_router.py", ...])
    │     └─→ on failure (no Python / script error):
    │           heuristicRoute()  [fallback-router.ts]  — keyword router, adds a warning
    │
    ├─→ loadWeights()      [weights.ts]
    │     └─→ .agency/routing-weights.json
    │
    └─→ applyWeightsToRoute()
         └─→ RouteResult { intent, workflow, skills, provider, suggested_agent }
```

### Files

| File | Purpose |
|------|---------|
| `model-router.ts` | High-level routing orchestrator — combines Python bridge + learned weights |
| `prompt-bridge.ts` | Calls `prompt_router.py` via skills-bridge, returns structured route |
| `weights.ts` | Loads/saves `.agency/routing-weights.json`, applies user feedback corrections |

### RouteResult Shape
```typescript
interface RouteResult {
  intent: string;           // "implement_feature", "fix_bug", "refactor", ...
  workflow: string;         // "plan", "debug", "review", ...
  skills: string[];         // ["codex-plan-writer", "codex-test-driven-development"]
  provider: ProviderId;     // "anthropic" | "openai" | ...
  suggestedAgent: string;   // "backend-specialist" | "planner" | "debugger" | ...
  confidence: number;       // 0.0–1.0
  warnings: string[];
}
```

---

## 2. Chat Orchestrator

**Location:** `packages/core/src/chat/`

### Standard Turn: `runChatTurn()`

```
runChatTurn({ prompt, projectRoot, skillsRoot, budget, providerId, history })
    │
    ├─→ 1. routeUserPrompt()          — determine intent + skills
    ├─→ 2. buildContextPack()          — assemble relevant files
    ├─→ 3. selectContextFiles()        — filter by intent
    ├─→ 4. getProvider().complete()    — LLM API call
    └─→ 5. formatChatTurnForSurface()  — TUI-friendly output
```

### Streaming Turn: `runChatTurnWithStream()`

Same pipeline, but LLM call uses `streamComplete()` with `onDelta` callbacks:

```
runChatTurnWithStream(opts, {
    onRoute: (ev) => { /* Got route result, update UI chips */ },
    onDelta: (token) => { /* Incremental token for live typewriter effect */ }
})
    │
    ├─→ routeUserPrompt()          → onRoute(event)
    ├─→ buildContextPack()
    ├─→ provider.streamComplete()  → onDelta(token) for each token
    └─→ toPresentationTurn()       → final chips + suggestions
```

### Governance Integration

- **Cost Budget**: `CostGovernor.getGovernanceState().isDepleted` throws before API call if budget exceeded
- **Auto-downgrade**: At 75% usage, switches Anthropic → Google (cheaper model)
- **Provider failover**: `ProviderSupervisor.getOptimalProvider()` reroutes if primary unhealthy
- **Token Budget Levels**:
  - `tight` — minimal context, routing metadata only
  - `normal` — selected files, balanced output
  - `deep` — extended context, more files, larger output

### Presentation: `toPresentationTurn()`
```
toPresentationTurn(result)
    └─→ PresentationTurn {
        body, chips, suggestions, cacheHint,
        tokenCount, costEstimate, provider, model
    }
```

---

## 3. LLM Provider Layer

**Location:** `packages/providers/src/`

### Adapter Architecture

```
                    ┌──────────────────┐
                    │  LlmProvider     │  (Interface)
                    │  • complete()    │
                    │  • streamComplete()
                    └────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
   ┌──────────┐       ┌──────────┐        ┌──────────┐
   │ OpenAI   │       │Anthropic │        │ Google   │
   │ Compatible│       │ Adapter  │        │ Adapter  │
   └──────────┘       └──────────┘        └──────────┘
         │                   │                   │
         ▼                   ▼                   ▼
   ┌──────────┐       ┌──────────┐        ┌──────────┐
   │OpenRouter│       │ NVIDIA   │        │  Local   │
   │ Adapter  │       │ Adapter  │        │ (Ollama) │
   └──────────┘       └──────────┘        └──────────┘
```

### Config Resolution (`config.ts`)

```typescript
// ~/.agency/config.json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": { "apiKey": "${ANTHROPIC_API_KEY}", "model": "claude-3-5-sonnet-20241022" },
    "openai":    { "apiKey": "${OPENAI_API_KEY}",    "model": "gpt-4o-mini" },
    "google":    { "apiKey": "${GOOGLE_API_KEY}",    "model": "gemini-2.0-flash" },
    "local":     { "model": "llama3.2" }
  }
}
```

- API keys use `${ENV_VAR}` placeholders — resolved at runtime from `process.env` (recommended; raw keys are accepted but warned against and masked in `config show`)
- `loadAgencyConfig()` → resolves placeholders → returns typed config

### Rate Limiter (`rate-limiter.ts`)
- `SmartRateLimiter` per-model tracking
- Exponential backoff on 429 responses
- Request queuing when rate limited

### Token Optimizer (`token-optimizer.ts`)
- `optimizeForTask()` — adjusts parameters per task intent
- `detectFlop()` — identifies low-quality completions for early abort

### Thinking Config (`thinking-spec.ts`)
- Per-model thinking variants (budget levels, named presets)
- Supports both Anthropic-style and OpenAI-style extended thinking

---

## 4. Context Pack System

**Location:** `packages/core/src/context/`

### `buildContextPack()`

```
buildContextPack(projectRoot, route, plan?)
    │
    ├─→ loadIndex()              — from .agency/index.json
    │     └─→ { files: [{ path, mtime, hash, language, size }], stats }
    │
    ├─→ buildFileTree()          — first 200 files as tree
    ├─→ selectContextFiles()     — relevance ranking by intent/workflow
    ├─→ truncateForTokenBudget() — fit within budget (tight/normal/deep)
    │
    └─→ Markdown context block string
```

### File References (`file-refs.ts`)
- `resolveAllFileReferences()` — resolve `@filename` mentions in prompt
- `buildAtReferenceContext()` — read referenced files into context

### Token Policy (`token-policy.ts`)
- `getTokenBudgetPlan()` — returns budget based on mode and model context window
- Budget allocation: system prompt + context + history + output buffer

### Session Cache (`session-cache.ts`)
- `getCachedRoute(key)` / `setCachedRoute(key, route)`
- SHA-256 keyed → `.agency/session/route-cache.json`
- TTL: 1 hour, pruned on read

---

## 5. Approval & Security

**Location:** `packages/core/src/approval/`

### Multi-layer Gating

```
User Action (shell command, skill tool, file write, workflow step)
    │
    ▼
requiresApproval(action)
    │
    ├─→ DENY_PATTERNS (23 destructive regex)
    │     └─→ "rm -rf /", "chmod 777", "docker rm", "git push --force", ...
    │
    ├─→ safety_policy.writes_artifacts → approval required
    ├─→ workflow.step.requiresApproval → approval required
    └─→ default: allow read-only operations
```

### ApprovalResult
```typescript
{ approved: boolean, reason?: string, requiresApproval: boolean }
```

### Audit Trail (`audit.ts`)
- `appendAudit()` → `.agency/audit.jsonl` (append-only)
- Records: timestamp, action, approval decision, user, tool name

### Risk Assessor (`risk-assessor.ts`)
- `RiskAssessor` class — scores actions by severity
- Categories: informational → low → medium → high → critical

### TUI Integration
- `PendingApproval` object passed to TUI
- User responds `y` (approve once), `n` (deny), or via approval mode
- `--yes` flag bypasses for headless CLI

---

## 6. Task Runner & Harness

**Location:** `packages/core/src/task/`

### Plan Parsing: `parsePlanTasks()`

Input: LLM-generated markdown with `### Task N:` headers

```
### Task 1: Set up project structure
Create directory layout and package.json.

### Task 2: Implement core logic
Write the main business logic in src/index.ts.
```

→ Output: `PlanTask[] = [{ id: 1, title: "Set up project structure" }, ...]`

### Plan Execution: `runPlan()`

```
runPlan(projectRoot, planPath, { skillsRoot, harness, maxAttempts, onTask })
    │
    ├─→ parsePlanTasks()
    ├─→ saveCheckpoint()              — .agency/tasks/<uuid>.json
    │
    └─→ for each task:
          ├─→ onTask(task) callback   — UI progress update
          │
          ├─→ if harness: runWithVerificationHarness(maxAttempts=3)
          │     ├─→ execute task via agent dispatch
          │     └─→ runGateQuick() verification (auto_gate.py)
          │         └─→ exitCode 0 = passed, retry if failed
          │
          ├─→ if gateEvery=N: run gate quick check
          └─→ saveCheckpoint()
```

### Checkpoints (`checkpoint.ts`)
- Persist to `.agency/tasks/<id>.json`
- Fields: `planPath`, `currentTask`, `completed[]`, `status`
- Resume via `agency task resume <id>` (or abort via `agency task abort <id>`)

### Harness Verification (`packages/core/src/skill/harness.ts`)
- `runWithVerificationHarness()` — max 3 attempts with loop detection
- Verification via `runGateQuick()` → Python `auto_gate.py`
- Gate exit code 0 = PASS, non-zero = FAIL → retry with error context

---

## 7. Agent Orchestrator

**Location:** `packages/core/src/agents/`

### Agent Profiles
8 predefined agents (`MANIFEST_AGENTS`) with discipline skills surfaced after dispatch (`AGENT_DISCIPLINES`):

| Agent ID | Role | Discipline Skills |
|----------|------|-------------------|
| `frontend-specialist` | Frontend implementation | codex-test-driven-development |
| `backend-specialist` | Backend implementation | codex-test-driven-development |
| `security-auditor` | Security analysis | codex-security-specialist |
| `debugger` | Systematic debugging | codex-systematic-debugging, codex-test-driven-development |
| `test-engineer` | Test authoring | codex-test-driven-development |
| `devops-engineer` | Build / deploy / infra | codex-security-specialist |
| `planner` | Architecture & planning | codex-plan-writer, codex-subagent-execution |
| `scrum-master` | Multi-agent coordination | codex-scrum-subagents |

> Custom agents can be added per-project via `.agency/agents.json` (`loadCustomAgents()`); `isAgentId()` accepts them too.

### Single Agent Dispatch: `dispatchAgent()`

```
dispatchAgent({ agentId, task, projectRoot })
    │
    ├─→ coerceAgentId()           — fallback to planner
    ├─→ buildContextPack()        — with agent-specific context
    ├─→ runChatTurn()             — LLM task completion
    ├─→ parseFileEditSuggestions()
    │     └─→ LockManager → StagingEngine → verify → commit/rollback
    ├─→ re-index workspace
    └─→ save dispatch record      — .agency/agents/dispatch-<ts>.json
```

### Parallel Agent Dispatch: `dispatchAgentsParallel()`

```
dispatchAgentsParallel(tasks, projectRoot)
    │
    ├─→ for each task: createIsolatedWorkspace()
    │     └─→ temp dir with workspace copy
    │
    ├─→ Promise.all([dispatchAgent(...), ...])
    │
    ├─→ mergeWorkspaceChanges()   — conflict resolution
    └─→ cleanIsolatedWorkspace()  — remove temp dirs
```

### Workspace Isolation (`workspace-isolation.ts`)
- `createIsolatedWorkspace()` — copy project to temp dir
- `mergeWorkspaceChanges()` — merge back with conflict detection
- `cleanIsolatedWorkspace()` — remove temp workspace

---

## 8. Workflow Composer

**Location:** `packages/core/src/workflow/compose.ts`

### 8 Predefined Workflows

| Workflow | Steps | Purpose |
|----------|-------|---------|
| `create` | runtime_hook → auto_gate | New feature creation |
| `plan` | runtime_hook → prompt_router | Architecture planning |
| `debug` | runtime_hook → pre_commit_check | Bug investigation |
| `review` | tech_debt_scan → security_scan | Code review |
| `deploy` | auto_gate (deploy mode) | Pre-deploy verification |
| `handoff` | memory_status → generate_handoff | Project handoff |
| `refactor` | runtime_hook → tech_debt_scan | Safe refactoring |
| `prototype` | init_spec → check_spec | Spec-driven prototyping |

### Execution
- Rutime hooks have 360s timeout
- preflight checks skipped by default to save tokens
- Steps requiring approval block until user confirms

---

## 9. Plan Execution (DAG)

**Location:** `packages/core/src/task/runner.ts`

### `runPlan` (+ `parsePlanTasks`, `detectDagCycle`)

```
runPlan(projectRoot, planPath, opts)
    │
    ├─→ parsePlanTasks  (### Task N: headers → PlanTask { id, title, dependencies })
    ├─→ detectDagCycle  (DFS; throws PlanCycleError on a dependency cycle)
    ├─→ schedule ready nodes (dependencies met) → dispatchAgent per task
    ├─→ per-task retry up to resolvedMaxAttempts
    ├─→ TaskCheckpoint save/load for crash-resume
    └─→ 0–6 level recovery escalation via ConvergenceEngine
```

> The earlier standalone `PlannerEngine` (its own `ExecutionDagContract` model with
> parallel execute + cascade rollback + 3s heartbeat) was a **dead duplicate** of this
> path — no live callers — and was removed (2026-05-31). Recover from git `0d216b9` if
> a programmatic DAG API is ever wanted.

---

## 10. Event Bus & Cognition

**Location:** `packages/core/src/events/`

### Event Bus (`event-bus.ts`)
- Singleton pub/sub pattern
- SHA-256 deduplication (5s sliding window)
- Wildcard `*` topic support
- Topics: `thought:emitted`, `dag:task:*`, `dag:rollback:initiated`, etc.

### Cognition Events (`cognition.ts`)
```typescript
emitThought({
  source: "routing" | "retrieval" | "editing" | "planning" | "verification",
  phase: "start" | "progress" | "complete" | "error",
  severity: "info" | "adaptation" | "warning" | "critical",
  message: string,
  metadata?: Record<string, unknown>
})
```

These are consumed by TUI's `CognitionPanel` for real-time thought display.

### Event Journal (`event-journal.ts`)
- SQLite-backed persistence for replay
- Schema: `events(sequence_id, timestamp, action, payload_hash, payload)`
- Checkpoints: `checkpoints(state_name, state_data)`

---

## 11. Skills Bridge

**Location:** `packages/skills-bridge/src/`

### Plugin Tools Contract (`plugin-tools.json`)
```json
{
  "tools": [
    {
      "name": "prompt_route",
      "script": ".system/scripts/prompt_router.py",
      "description": "Route user prompts to workflows and agents",
      "safety_policy": { "writes_artifacts": false, "network_access": false }
    }
  ]
}
```

### Built-in Scripts (`builtins.ts`)
`BUILTIN_SCRIPTS` — 4 direct mappings for common operations:

| Name | Script |
|------|--------|
| `prompt_route` | `.system/scripts/prompt_router.py` |
| `plugin_validate` | `.system/scripts/validate_codex_plugin.py` |
| `runtime_hook` | `codex-runtime-hook/scripts/runtime_hook.py` |
| `auto_gate` | `codex-execution-quality-gate/scripts/auto_gate.py` |

> Other pack scripts (`pre_commit_check.py`, `memory_status.py`, `tech_debt_scan.py`, `security_scan.py`, `generate_handoff.py`, …) are run by workflow steps (`workflow/compose.ts`) via full pack-relative paths, not via `BUILTIN_SCRIPTS`.

### Skill Aliases (`aliases.ts`)
`SKILL_ALIASES` maps ~70 `$`-prefixed shortcuts to skill packs (`resolveSkillAlias()`). A sample:
```
$plan    → codex-plan-writer
$tdd     → codex-test-driven-development
$gate    → codex-execution-quality-gate
$sdd     → codex-subagent-execution
$spec    → codex-spec-driven-development
$hook    → codex-runtime-hook
$verify  → codex-verification-discipline
$debug   → codex-systematic-debugging
$finish  → codex-branch-finisher
$create / $review / $deploy / $refactor / $handoff → codex-workflow-autopilot
```

### Runner (`runner.ts`)
- `runTool(toolName, args)` — execute Python script via `execa`
- `runBuiltinScript(name, args)` — direct builtin call
- Safety gating: checks `safety_policy` before execution

---

## 12. Workspace Index System

**Location:** `packages/core/src/index/`

### Full Index: `buildIndex(projectRoot)`
- Scans all files (respects `.gitignore`)
- Detects language, binary/text
- Records mtime, size, hash
- Output: `.agency/index.json`

### Incremental Update: `incrementalUpdateAsync(projectRoot, { onProgress, signal })`
- Compares mtimes with existing index
- Only re-scans changed files
- `onProgress` callback for TUI display
- Abortable via `AbortSignal`

### Deep Indexing: `incremental-indexer.ts`
- `extractSymbolsAndImports()` — AST-level symbol extraction
- Optional, enabled only for deep budget mode

### Gitignore Parser (`gitignore-parser.ts`)
- `IgnoreFilter` class — respects `.gitignore` rules

---

## 13. Memory Subsystem

**Location:** `packages/memory/src/`

### SQLite Database (`db.ts`)
- Path: `$PROJECT/.agency/memory/memory.db`
- WAL mode, NORMAL synchronous
- Shadow backup at `.db.shadow`
- Auto-recovery on corruption

### Tables

| Table | Purpose |
|-------|---------|
| `episodes` | Agent memory episodes with lifecycle, Lamport timestamps |
| `episodes_fts` | FTS5 full-text search over goals/content |
| `vectors` | Vector embeddings (float arrays, dimension-validated) |
| `graph_edges` | Knowledge graph edges (source, target, relation, weight) |
| `event_log` | Append-only event log |
| `audit_log` | Mutation audit trail |
| `quarantined_vectors` | Bad vectors for review |

### Vector Store (`vector-store.ts`)
- Cosine similarity search
- Dimension validation
- Threshold filtering
- Optional native kernel plugin support

### CRDT Merger (`lifecycle.ts`)
- Lamport-timestamp-based merging for vectors and episodes
- Multi-agent reconciliation

### Retention Policy (`lifecycle.ts`)
- `PolicyEngine` — TTL-based archiving per memory type
- `GraphIntegritySupervisor` — orphan pruning, cycle detection

---

## 14. Governance & Cost Control

**Location:** `packages/governance/src/`

### Cost Governor (`cost-governance.ts`)
- `CostGovernor` singleton
- Tracks accumulated API cost per session
- Per-model cost estimation (per 1M tokens)
- Hard budget ceiling → throws `BudgetExceededError`
- Auto-downgrade at 75%: Anthropic → Google

### Provider Supervisor (`provider-supervisor.ts`)
- `ProviderSupervisor` singleton
- Health registry per provider
- Latency tracking
- Auto-failover when failure rate >50%
- `getOptimalProvider()` returns healthiest available

---

## 15. Security & Sandboxing

**Location:** `packages/security/src/`

### Security Levels (`SecurityLevel` enum)
5-level hierarchical escalation — a tool is allowed only if its level ≤ the session's `maxAllowedLevel`:
1. **Safe** — `math`, `status`, `list_permissions`
2. **ReadOnly** — `view_file`, `list_dir`, `grep_search`, `read_resource`
3. **WorkspaceWrite** — `write_to_file`, `replace_file_content`, `multi_replace_file_content` (default for unmapped actions)
4. **Network** — `read_url_content`, `search_web`, `execute_url`
5. **Privileged** — `run_command` (terminal, Docker shell)

### Sandbox
- **DockerSandbox**: Network isolation, read-only FS, memory/CPU limits
- **NativeSandbox**: Direct `execa`, requires Level 5 (Privileged)

### Egress & Process Hardening
- `EgressFilterProxy` (`egress-proxy.ts`) — domain-allowlist filtering for network egress (`matchGlob()`)
- `ProcessJail` (`process-jail.ts`) — restricts capabilities of spawned child processes

---

## 16. Terminal Sandbox

**Location:** `packages/core/src/terminal/sandbox.ts`

### `runShellCommand()`

```
runShellCommand(projectRoot, command, { capture?, yes? })
    │
    ├─→ SecurityEscalationManager.checkAccess()
    ├─→ requiresApproval(command)     — check DENY_PATTERNS
    │     └─→ if destructive && !yes → ApprovalRequiredError
    │
    ├─→ DockerSandbox / NativeSandbox
    └─→ appendAudit()                 — log to audit.jsonl
```

---

## 17. Workspace Operations

**Location:** `packages/workspace/src/`

### Lock Manager (`lock-manager.ts`)
- In-memory file-level locks with queuing
- Timeout: 15s default
- Auto-release safety timers (deadlock prevention)

### Staging Engine (`staging-engine.ts`)
- Virtual file transactions
- Shadow workspace verification (`pnpm build` in temp dir)
- Atomic commit or rollback

### Recovery Engine (`recovery-engine.ts`)
- Backup/restore via temp directories
- Git rollback fallback
- Integrity verification

---

## 18. Output Engine

**Location:** `packages/core/src/output/` (16 modules)

The headless/streaming output renderer that turns orchestration events into surface-ready strings.

- `output-engine.ts` — `OutputEngine`, the central renderer
- `formatters/` — `event-`, `failure-`, `patch-`, `phase-`, `result-`, `table-formatter` produce typed segments
- `filters/` — `output-filter` suppresses/throttles noisy output
- `utils/` — `byte-format`, `time-format`, `worker-names` helpers

This layer backs both the CLI's headless rendering and the data the TUI's runtime cards consume.

---

## 19. MCP Runtime

**Location:** `packages/core/src/mcp/`

- `config.ts` — `loadMcpConfigs()` reads MCP server definitions
- `client.ts` — `McpClient` plus `initializeMcpServers()` / `shutdownMcpServers()` and the `activeMcpClients` registry — live connections to MCP servers, exposing `McpToolDefinition`s into the tool registry

---

## Other notable core modules

- `validation/correctness-science.ts` — runtime correctness harness (`RuntimeInvariantEngine`, `LinearizabilityValidator`, `LatencyProfiler`, `ConvergenceTracker`, `DeterministicPRNG`)
- `task/convergence-engine.ts` — `ConvergenceEngine` with 0–6 recovery levels for long-running task convergence
- `chat/circuit-breaker.ts` — tool-failure circuit breaker guarding the chat loop
- `kernel/entropy-provider.ts` — `DeterministicEntropy` / `DeterministicClock` + `installDeterministicGlobals()` for reproducible runs
- `utils/ast-compiler.ts` — AST-level patch operations (`applyPatch`, `replaceFunctionBody`, `renameSymbol`, …)

---

## Subsystem Connections

```
                    ┌──────────────┐
                    │  CLI / TUI   │
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Chat           │  │ Task Runner   │  │ Workflow      │
│ Orchestrator   │  │               │  │ Composer      │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
              ┌────────────────────────┐
              │   ROUTING LAYER        │
              │   model-router.ts      │
              │   prompt-bridge.ts     │
              │   weights.ts           │
              └────────────┬───────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Context Pack  │  │ Provider Layer│  │ Agent Dispatch│
│ Builder       │  │ (6 adapters)  │  │ Orchestrator  │
└───────────────┘  └───────────────┘  └───────────────┘
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Approval      │  │ Governance    │  │ Workspace     │
│ Engine        │  │ (cost+health) │  │ (lock+stage)  │
└───────────────┘  └───────────────┘  └───────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Event Bus     │  │ Memory Store  │  │ Workspace     │
│ (pub/sub)     │  │ (SQLite)      │  │ Indexer       │
└───────────────┘  └───────────────┘  └───────────────┘
```
