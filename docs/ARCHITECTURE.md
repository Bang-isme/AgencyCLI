# Agency CLI — Kiến trúc Hệ thống

## Tổng quan

Agency CLI là một **monorepo AI agent CLI** gồm 16 packages, xây dựng bằng TypeScript (ESM, NodeNext), chạy trên Node ≥22, quản lý bằng pnpm workspaces. Hệ thống cung cấp cả chế độ **headless CLI** (21 subcommands) và **TUI tương tác** (React/Ink terminal UI).

## Cấu trúc Monorepo

```
AgencyCLI/
├── packages/           (16 packages)
│   ├── cli/            — Entry point, Commander subcommands, TUI/headless dispatch
│   ├── tui/            — Ink/React terminal UI shell
│   ├── core/           — Central orchestration kernel (routing, chat, approval, tasks, agents, workflows)
│   ├── contracts/      — Shared TypeScript type definitions (zero deps)
│   ├── providers/      — LLM adapters (OpenAI, Anthropic, Google, OpenRouter, NVIDIA, local)
│   ├── tooling/        — JSON repair engine, schema coercion, tool registry, MCP supervisor
│   ├── workspace/      — File locking, virtual staging, recovery engine
│   ├── context/        — Context degradation & tier management
│   ├── memory/         — SQLite episodic + vector + graph memory
│   ├── governance/     — Token/cost governance, provider health supervision
│   ├── heuristics/     — Loop detection, goal anchoring, risk refinement
│   ├── security/       — Hierarchical security escalation, Docker/Native sandbox, egress proxy, process jail
│   ├── skills-bridge/  — CodexAI Python skills pack bridge
│   ├── benchmark/      — Isolated benchmark task runner
│   ├── browser/        — Playwright/CDP browser automation runtime
│   └── telemetry/      — Execution tracing, profiling, deterministic replay
├── docs/               — System documentation
├── scripts/            — PowerShell CI/CD scripts
└── tests/              — Fixtures & integration test data
```

## Phân lớp Kiến trúc (Layered Architecture)

```
┌──────────────────────────────────────────────────────┐
│  ENTRY LAYER                                         │
│  packages/cli/                                       │
│  • Binary entry (agency, acg)                        │
│  • 21 Commander subcommands                          │
│  • TUI vs headless dispatch (tui-launch.ts)           │
├──────────────────────────────────────────────────────┤
│  PRESENTATION LAYER                                  │
│  packages/tui/                                       │
│  • Ink/React terminal UI                             │
│  • 42 components, 13 overlays                        │
│  • Animation system, theme system                    │
├──────────────────────────────────────────────────────┤
│  ORCHESTRATION LAYER (HUB)                           │
│  packages/core/                                      │
│  • Prompt routing + routing weights                  │
│  • Chat orchestrator + streaming                     │
│  • Approval policy + audit                           │
│  • Task runner + checkpoints                         │
│  • Agent orchestrator + workspace isolation          │
│  • Workflow composer                                 │
│  • Planner engine (DAG)                              │
│  • Context pack builder                              │
│  • Event bus + journal                               │
│  • Workspace indexer                                 │
│  • Scheduler, MCP config, skill harness              │
├──────────────────┬───────────────────┬───────────────┤
│  PROVIDER LAYER  │  TOOLING LAYER    │  MEMORY LAYER │
│  (providers/)    │  (tooling/)       │  (memory/)    │
│  • 6 LLM adapters│  • JSON repair    │  • SQLite DB  │
│  • Rate limiter  │  • Schema coercion│  • Episodic    │
│  • Token optimizer│  • Tool registry │  • Vectors     │
│  • Config loader │  • MCP supervisor │  • Graph edges │
│                  │                   │  • FTS5 search │
├──────────────────┼───────────────────┼───────────────┤
│  CROSS-CUTTING LAYER                                │
│  governance/ — cost governor, provider supervisor    │
│  heuristics/ — loop detector, goal pillars           │
│  security/   — escalation manager, sandbox           │
│  context/    — degradation engine                    │
│  telemetry/  — trace tracker, replay engine          │
│  workspace/  — lock manager, staging, recovery       │
│  contracts/  — shared TypeScript types (private)     │
├──────────────────────────────────────────────────────┤
│  INTEGRATION LAYER                                   │
│  skills-bridge/ — Python skills pack runner          │
│  browser/       — Playwright/CDP automation          │
│  benchmark/     — regression trace replayer          │
└──────────────────────────────────────────────────────┘
```

## Dependency Graph

```
                    contracts (types only, private)
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
     heuristics       governance          tooling
      (0 deps)         (0 deps)       (contracts)
          │                │
          ▼                ▼
     security           context
      (0 deps)         (0 deps)
          │                │
          └────────┬───────┘
                   ▼
              telemetry
               (0 deps)
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
  workspace     providers       memory
  (execa)        (zod)      (governance,
                            better-sqlite3)
    │              │              │
    └──────────────┼──────────────┘
                   ▼
              ┌─────────┐
              │  CORE   │  (hub: contracts, providers, workspace,
              │         │   tooling, context, heuristics, governance,
              │         │   security, better-sqlite3, execa, zod)
              └────┬────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
skills-bridge   benchmark        TUI
(+core, execa,  (+core,        (+core,
 zod)            telemetry,     providers,
                 governance)    ink, react)
    │              │              │
    └──────────────┼──────────────┘
                   ▼
              ┌─────────┐
              │   CLI   │  (leaf: core, tui, skills-bridge,
              │         │   benchmark, commander, execa)
              └────┬────┘
                   │
              ┌────┴────┐
              ▼         ▼
           agency      acg
         (headless)   (TUI)
```

**Quy tắc quan trọng:**
- `@agency/contracts` là `private: true` — không bao giờ publish, chỉ dùng chung type khi build
- Bottom-tier packages có **zero inter-package dependencies** — decoupling tối đa
- `@agency/core` là **hub** duy nhất — phụ thuộc 8 sibling packages + 3 external
- `@agency/cli` là **leaf entry** — phụ thuộc core, tui, skills-bridge, benchmark

## Entry Points

### Binary: `packages/cli/src/index.ts`

```
#!/usr/bin/env node
agency <args>   → headless mode (có subcommand)
agency          → TUI mode (không subcommand)
acg <path>      → luôn TUI mode
```

**Luồng quyết định TUI vs Headless** (`tui-launch.ts`):
1. `argv` rỗng hoặc chỉ có project path → **TUI mode**
2. `basename(argv[1]) === "acg"` → **TUI mode**
3. Có subcommand → **Headless mode** → Commander parse

### TUI Mode
- Dynamic import `@agency/tui` → `render()`
- Ink React app trong alternate screen buffer
- Phase flow: Splash → Welcome → Main

### Headless Mode
- `registerCommands(program)` → 21 Commander subcommands
- Mỗi subcommand map đến handler trong `packages/cli/src/commands/`

## Build System

| Thuộc tính | Giá trị |
|---|---|
| Language | TypeScript (ESM, NodeNext) |
| Target | ES2022 |
| Node | ≥22 |
| Package manager | pnpm@9.0.0 + workspaces |
| Builder | `tsc -p tsconfig.json` (per package) |
| Project refs | `composite: true`, `references: [...]` |
| Base config | `tsconfig.base.json` (shared) |
| No bundler | Pure tsc → dist/, ESM imports |
| Testing | Vitest |
| Prepack | `pnpm run build` (mọi package) |

## Data Flow: Vòng đời một User Prompt

```
User Input (TUI Composer)
    │
    ▼
Slash Command? ──Yes──→ executeSlash() → overlay/system action
    │
    No
    ▼
Shell Command? (!cmd) ──Yes──→ requiresApproval() → runShellCommand()
    │
    No
    ▼
Agent Mode prefix ($plan, $debug, [READ-ONLY])
    │
    ▼
runChatTurnWithStream()
    │
    ├─→ routeUserPrompt()
    │     └─→ routePrompt() → Python prompt_router.py → RouteResult
    │
    ├─→ buildContextPack()
    │     └─→ workspace index + file selection + token budget
    │
    ├─→ provider.complete() / streamComplete()
    │     └─→ LLM API call (Anthropic/OpenAI/Google/...)
    │
    ├─→ parseFileEditSuggestions()
    │     └─→ SEARCH/REPLACE pattern detection
    │
    ├─→ Approval (y/n) for file writes
    │     ├─→ writeFileSync() + mkdirSync()
    │     └─→ buildIndex() + writeIndex()
    │
    └─→ Memory pipeline
          └─→ Episode store + vector store + graph store
```

## Key Design Patterns

### 1. Python Skills Bridge (Read-only)
Skills pack Python scripts là **read-only**. CLI không bao giờ sửa skills. Tương tác qua `execa` + `plugin-tools.json` contracts.

### 2. Multi-layer Approval
Cùng một `requiresApproval()` / `assertApproval()` bảo vệ: shell commands, skill tools, workflow steps, file writes. TUI hiển thị `y/n` prompt.

### 3. Transactional File Editing
`LockManager.acquireLock()` → `StagingEngine.stageFile()` → verify (`pnpm build`) → commit hoặc rollback.

### 4. Checkpoint-driven Task Runner
Mỗi task step persist state (`tasks/<id>.json`), cho phép crash recovery. Harness verification loop (max 3 attempts) với auto-gate.

### 5. Cognition via Event Bus
`EventBus` singleton pub/sub với SHA-256 dedup. Routing, retrieval, editing phase emit `runtimeThoughtEvent` → TUI CognitionPanel real-time display.

### 6. Provider Failover + Cost Governance
`CostGovernor` theo dõi token usage, auto-downgrade ở 75% budget. `ProviderSupervisor` health check + automatic failover.

### 7. Workspace Isolation for Parallel Agents
`createIsolatedWorkspace()` tạo temp dir cho mỗi agent → merge changes → clean temp dir.

### 8. DAG Scheduler
`runPlan` (`task/runner.ts`) hỗ trợ dependency graph (`parsePlanTasks`), static cycle detection (`detectDagCycle` → `PlanCycleError`), per-task retries, checkpoint-based resume, và recovery escalation qua `ConvergenceEngine`.
