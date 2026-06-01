# Agency CLI — Complete Package Reference

## Introduction

This document provides a **module-level** reference for every one of the 16 packages in the Agency CLI monorepo. Each package section lists every module file, every export, and the exact purpose of each function, class, type, and constant.

---

## 1. `@agency/contracts` — Shared Type Definitions

**Zero dependencies. `private: true` — never published, shared at build time only.**

### Files

| File | Purpose |
|------|---------|
| `types.ts` | All shared TypeScript interfaces and types |

### Exports by Category

**Execution & Governance:**
| Export | Purpose |
|---|---|
| `ExecutionContext` | Active execution context: project root, skills root, budget mode, agent ID, plan path, task ID, signal |
| `GovernanceContext` | Budget ceiling, provider health state, auto-downgrade flag, cost accumulator |

**DAG & Planning:**
| Export | Purpose |
|---|---|
| `PatchOperation` | A single code change: `type` (Replace/Insert/Delete), `filePath`, `content`, `search?`, `oldContent?` |
| `ReplayEvent` | Deterministic replay event: `sequence`, `action`, `payload`, `hash` |
| `DagTaskNode` | DAG node: `id`, `dependencies[]`, `rollbackPaths[]`, `retryCount`, `status` |
| `ExecutionDagContract` | DAG contract: `nodes`, `edges`, `metadata` |

**Approval & Autonomy:**
| Export | Purpose |
|---|---|
| `AutonomyMode` | `"safe" \| "balanced" \| "autonomous" \| "ci"` |
| `RiskLevel` | `"LOW" \| "MEDIUM" \| "HIGH" \| "CRITICAL"` |
| `RiskScore` | `{ filesystem, shell, network, privilege, destructive, overall, level }` |
| `ApprovalRequest` | Request shape: `action`, `params`, `riskScore`, `opts` |
| `ApprovalScopeType` | `"session" \| "branch" \| "temporary"` |
| `ContinuationPolicy` | `"proceed_autonomous" \| "readonly_fallback" \| "reject"` |

**Cognition:**
| Export | Purpose |
|---|---|
| `RuntimeThoughtEvent` | Event emitted to bus: `source` (routing/retrieval/editing/...), `phase`, `severity`, `message`, `metadata` |

---

## 2. `@agency/core` — Central Orchestration Hub

**Dependencies:** `@agency/contracts`, `@agency/providers`, `@agency/tooling`, `@agency/workspace`, `@agency/context`, `@agency/heuristics`, `@agency/governance`, `@agency/security`, `better-sqlite3`, `execa`, `zod`

### Complete Module Inventory (82 modules, 333-line barrel)

| Module | Purpose |
|--------|---------|
| `index.ts` | Public barrel — re-exports everything |
| `project.ts` | `getWorkspaceRoot(start)` — walks up to find `package.json` |
| `skills-root.ts` | `resolveSkillsRoot()` — cascade of env vars + hardcoded paths |

**`chat/` — Chat Orchestration:**
| Module | Key Exports |
|--------|------------|
| `orchestrator.ts` | `ChatTurnInput`, `ChatTurnResult`, `runChatTurn(input)` — full pipeline (route → context → LLM → format), `runPlan()`, `parsePlanTasks()` |
| `stream.ts` | `runChatTurnWithStream(input, handlers)` — streaming variant with `onRoute`/`onDelta` callbacks |
| `presentation.ts` | `toPresentationTurn()`, `routeToChips()`, `formatChatTurnForSurface()` |
| `prompt.ts` | `buildSystemPrompt()` — assembles the agent system prompt |
| `memory-integration.ts` | `loadHistoricalMemories()`, `safeAddEpisode()` — wires chat to `@agency/memory` |
| `circuit-breaker.ts` | `createCircuitBreaker()`, `checkCircuitBreaker()`, `recordToolFailure/Success()` — tool-failure circuit breaker |
| `turn-helpers.ts` | `resolveRoute()`, `providerHasKey()`, `repackContextAndSystemPrompt()`, `compactTurnHistory()`, `recordTurnTokenCost()` — logic shared by orchestrator.ts + stream.ts (single source) |
| `trace-recorder.ts` | `SessionTraceRecorder`, `createTraceRecorder()` — §2.5 behaviour-trace recording to `.agency/traces/` (flag `AGENCY_TRACE_RECORD`) |

**`router/` — Prompt Routing:**
| Module | Key Exports |
|--------|------------|
| `model-router.ts` | `routeUserPrompt(skillsRoot, prompt, projectRoot)` — route → normalize → apply weights; falls back to `heuristicRoute()` when the Python router fails |
| `prompt-bridge.ts` | `routePrompt(skillsRoot, prompt)` — Python `prompt_router.py` via execa |
| `fallback-router.ts` | `heuristicRoute(prompt, provider)` — dependency-free keyword router used when Python is unavailable |
| `weights.ts` | `loadWeights()`, `recordFeedback()`, `applyWeightsToRoute()` — self-learning routing |

**`context/` — Context Assembly:**
| Module | Key Exports |
|--------|------------|
| `pack.ts` | `buildContextPack(projectRoot, route, plan)` — markdown context block |
| `file-refs.ts` | `fuzzySearchFiles()`, `resolveAllFileReferences()`, `buildAtReferenceContext()` |
| `selector.ts` | `selectContextFiles()` — relevance-ranked file selection |
| `session-cache.ts` | `getCachedRoute()` / `setCachedRoute()` — 1hr SHA-256 TTL cache |
| `token-policy.ts` | `getTokenBudgetPlan(mode)` — tight/normal/deep presets |

**`approval/` — Security Gates:**
| Module | Key Exports |
|--------|------------|
| `patterns.ts` | `DENY_PATTERNS` (destructive regex), `isDestructiveCommand()` |
| `policy.ts` | `requiresApproval()`, `assertApproval()`, `ApprovalRequiredError` |
| `audit.ts` | `appendAudit()` — JSONL audit trail |
| `risk-assessor.ts` | `RiskAssessor.assessRisk()` — 5-dimension risk scoring |
| `approval-policy-engine.ts` | `ApprovalPolicyEngine` — autonomy modes, escalation, timeout policies |
| `index.ts` | Approval subsystem barrel |

**`agents/` — Multi-Agent System:**
| Module | Key Exports |
|--------|------------|
| `types.ts` | `MANIFEST_AGENTS` (8 agents: frontend-specialist, backend-specialist, security-auditor, debugger, test-engineer, devops-engineer, planner, scrum-master), `AgentId`, `isAgentId()` |
| `profiles.ts` | `AGENT_DISCIPLINES`, `AGENT_SUBAGENT_PROMPT`, `coerceAgentId()`, `loadCustomAgents()`, `subagentPromptPath()` |
| `orchestrator.ts` | `dispatchAgent()`, `dispatchAgentsParallel()` — with staging + re-index |
| `workspace-isolation.ts` | `createIsolatedWorkspace()`, `mergeWorkspaceChanges()` |
| `agent-registry.ts` | `CapabilityAgentRegistry`, `capabilityRegistry`, `inferCapabilities()` — capability-driven routing + agent health/utilization (flag `AGENCY_CAPABILITY_ROUTING`) |

**`task/` — Plan Execution:**
| Module | Key Exports |
|--------|------------|
| `runner.ts` | `parsePlanTasks()`, `runPlan()` — checkpoint-driven execution |
| `checkpoint.ts` | `saveCheckpoint()`, `loadCheckpoint()`, `abortCheckpoint()` |
| `convergence-engine.ts` | `ConvergenceEngine` — structural convergence + 0–6 recovery levels |

**`skill/` — Skill Execution:**
| Module | Key Exports |
|--------|------------|
| `harness.ts` | `runWithVerificationHarness()` — max 3 retry + auto_gate |
| `tool-harness.ts` | `parseToolCalls()`, `executeTool()`, `registry`, `truncateToolResult()` — tool-call loop + registry |
| `invoke-actions.ts` | `getInvokeActions()` — resolves skill invoke actions |

**`output/` — Output Rendering Engine (16 modules):**
| Module | Key Exports |
|--------|------------|
| `output-engine.ts` | `OutputEngine` — central headless output renderer |
| `output-types.ts` / `index.ts` | Output payload types + barrel |
| `formatters/*.ts` | `event-`, `failure-`, `patch-`, `phase-`, `result-`, `table-formatter` + barrel |
| `filters/*.ts` | `output-filter` + barrel — output suppression/filtering |
| `utils/*.ts` | `byte-format`, `time-format`, `worker-names` + barrel |

**Other Modules:**
| Module | Key Exports |
|--------|------------|
| `workflow/compose.ts` | `runWorkflow()` — 8 predefined workflow chains |
| `events/event-bus.ts` | `EventBus` (singleton pub/sub, SHA-256 dedup) |
| `events/event-journal.ts` | `EventJournal` — SQLite-backed replay |
| `events/replay-engine.ts` | `ReplayEngine`, `verifyJournalReplay()`, `replaySessionJournal()` — replay-verify the durable journal (powers `agency replay`) |
| `events/cognition.ts` | `emitThought()` — structured cognition events |
| `index/workspace-indexer.ts` | `buildIndex()`, `incrementalUpdateAsync()`, `writeIndex()` |
| `index/incremental-indexer.ts` | `extractSymbolsAndImports()` — AST-level symbols |
| `index/gitignore-parser.ts` | `IgnoreFilter` — respects `.gitignore` |
| `index/language-map.ts` | `detectLanguage()`, `isBinaryExtension()` |
| `git/intelligence.ts` | `getGitSummary()` — branch, status, recent commits |
| `browser/mcp-hint.ts` | `getBrowserMcpStatus()` — Cursor MCP detection |
| `graph/loader.ts` | `loadKnowledgeGraph()` — reads `.codex/knowledge/` |
| `graph/builder.ts` | `buildKnowledgeGraph()`, `updateKnowledgeGraphForFiles()` |
| `mcp/config.ts` | `loadMcpConfigs()` — MCP server definitions |
| `mcp/client.ts` | `McpClient`, `initializeMcpServers()`, `shutdownMcpServers()`, `activeMcpClients` |
| `scheduler/schedule.ts` | `addSchedule()`, `listSchedules()`, `runDueSchedules()`, `everyFlagToCron()` |
| `team/store.ts` | `initTeam()`, `addMember()` |
| `team/schema.ts` | Team config Zod schema/types |
| `terminal/sandbox.ts` | `runShellCommand()` — sandboxed shell execution |
| `memory/bridge.ts` | `runMemoryScript()` |
| `memory/compact.ts` | `compactContext()` |
| `kernel/entropy-provider.ts` | `DeterministicEntropy`, `DeterministicClock`, `installDeterministicGlobals()`, `deterministicPromiseRace()` |
| `utils/ast-compiler.ts` | `applyPatch()`, `replaceFunctionBody()`, `renameSymbol()`, `insertFunction()`, … — AST patch ops |
| `utils/file-parser.ts` | SEARCH/REPLACE edit parsing |
| `utils/package-manager.ts` | `detectPackageManager()`, `getBuildCommand()`, `getTestCommand()`, `getInstallCommand()` |
| `utils/governance-instance.ts` | Shared governance singleton accessor |

---

## 3. `@agency/tui` — Terminal UI (React/Ink)

**Dependencies:** `@agency/core`, `@agency/providers`, `ink`, `react`

### File Inventory (41 components in `components/`, 50 `.tsx` total, 24 tests)

**Entry & Layout:**
| File | Purpose |
|------|---------|
| `index.ts` | `render(opts)` — launch TUI with provider chain |
| `App.tsx` | Monolith: 25+ useState, all overlays, all input routing, chat pipeline |
| `layout/TerminalLayoutProvider.tsx` | Terminal measurement context (+ `useTerminalLayout()`) |
| `layout/terminal-layout.ts` | `measureTerminal()`, `panelWidth()`, `contentWidth()` |
| `layout/Shell.tsx` | Header / Body / Composer / StatusBar chrome |
| `layout/TerminalViewport.tsx` | Full-viewport wrapper |
| `layout/ComposerStack.tsx` | Fixed-width bottom input stack |
| `layout/Header.tsx` | Version + project path header |
| `layout/StatusBar.tsx` | Bottom bar: mode, spinner, model, context% |

**Input Components:**
| File | Purpose |
|------|---------|
| `components/ComposerBlock.tsx` | Full input stack: menu/at-picker/composer |
| `components/PromptComposer.tsx` | Text input with ❯ cursor + mode label |
| `components/SlashMenu.tsx` | `/` command autocomplete |
| `components/AtPicker.tsx` | `@` file autocomplete |

**Conversation Components:**
| File | Purpose |
|------|---------|
| `components/Conversation.tsx` | Virtual-line scrolling message list (memo) |
| `components/EmptyChat.tsx` | Dashboard when conversation empty |
| `components/SystemNotice.tsx` | Context-aware system message formatting |
| `components/Chip.tsx` | Single `<label>:<value>` chip |
| `components/LoadingIndicator.tsx` | Simple spinner |

**Overlays (12 modals):**
| File | Key Binding | Purpose |
|------|------------|---------|
| `components/HelpOverlay.tsx` | `?` key | Slash commands, key bindings |
| `components/ConnectOverlay.tsx` | `/connect` | API key/provider management |
| `components/ModelsOverlay.tsx` | `/models` | Model picker |
| `components/SkillsPicker.tsx` | `/skills` | Skill browser/inject |
| `components/PluginsOverlay.tsx` | `/plugins` | Skill pack viewer |
| `components/ReviewMenu.tsx` | `/review` | Code review action picker |
| `components/StatusDashboard.tsx` | `/status` | System telemetry |
| `components/VariantOverlay.tsx` | `/variant` | Thinking budget selector |
| `components/McpOverlay.tsx` | `/mcp` | MCP server CRUD |
| `components/RouteOverlay.tsx` | `/route` | Prompt-routing preview (skill/model/intent) |
| `components/SubagentsOverlay.tsx` | `/agents` | Dispatch history viewer |
| `components/SessionPicker.tsx` | `/sessions` | Resume/delete sessions |
| `components/WelcomeScreen.tsx` | `/project` | Project switcher |

**Special Components:**
| File | Purpose |
|------|---------|
| `components/Splash.tsx` | Cyberpunk boot animation (384 lines) |
| `components/WelcomeMenu.tsx` | 3-option startup menu |
| `components/GlowingLogo.tsx` | Pixel-art AGENCYCLI neon logo |
| `components/AnimatedText.tsx` | ShimmerText, TypewriterText, SpinnerText, WaveText, BlinkCursor |
| `components/GoalRunner.tsx` | Multi-step goal with energy bar |
| `components/IndexProgress.tsx` | Index scan progress indicator |
| `components/ToolActivity.tsx` | Loading: spinner + phase + elapsed + tokens |
| `components/CognitionPanel.tsx` | Runtime thought log (3 disclosure levels) |
| `components/DataView.tsx` | DataTable, CodeBlock, DiffBlock, ProgressBar |
| `components/RuntimeCard.tsx` | Runtime UX card component |
| `components/WorkerProgress.tsx` | Worker step tracker |
| `components/TrustCard.tsx` | Trust/confidence card |
| `components/FailureCard.tsx` | Failure display card |
| `components/PatchCard.tsx` | Code patch card |
| `components/LogCollapse.tsx` | Collapsible log view |
| `components/SubagentPanel.tsx` | Subagent status panel |
| `components/ExecutionPanel.tsx` | Phase/severity execution panel (lifecycle + severity glyphs) |
| `components/ErrorBanner.tsx` | Inline error notification banner (`ErrorNotification`) |
| `components/conversation/TraceTelemetry.tsx` | Inline trace/telemetry readout in conversation |
| `components/conversation/SubagentStepRow.tsx` | Per-step subagent row with status highlighting |

**State & Utilities:**
| File | Purpose |
|------|---------|
| `state/agent-modes.ts` | 4 modes: agent/plan/debug/ask |
| `state/context-tracker.ts` | Token estimate, activity phases |
| `state/DisclosureProvider.tsx` | 3-tier progressive disclosure |
| `state/HeartbeatProvider.tsx` | Silence budget detection |
| `state/messages.ts` | `SessionMessage` type, `newMessageId()` |
| `state/semantic-orchestration.ts` | `SemanticTranslator`, worker-lifecycle state for semantic events |
| `presentation/turn.ts` | Re-exports core presentation helpers for the TUI surface |
| `presentation/slash-menu.ts` | `SLASH_MENU`, `filterSlashMenu()`, `getSlashQuery()` |
| `theme.ts` | Root theme token accessor |
| `types.ts` | Shared TUI types |
| `sessions/store.ts` | Session CRUD (JSON files) |
| `sessions/projects.ts` | Recent projects tracker |
| `sessions/sanitize.ts` | Session content sanitization |
| `sessions/persist-queue.ts` | Debounced session save (450ms) |
| `slash/commands.ts` | 20+ slash command implementations |
| `at/utils.ts` | `@` reference query parsing |
| `utils/text.ts` | Text width, grapheme deletion, `formatElapsed`, `padEndWide`, `wrapText` |
| `utils/file-parser.ts` | SEARCH/REPLACE file edit parser |
| `utils/spec-source.ts` | `getSpecSourceColor()` — spec-source badge coloring |
| `utils/conversation/activity-parser.ts` | `isSystemActivityLine()`, `isSubagentNotice()`, `isThinkingOrExploreNotice()` |
| `utils/conversation/tool-labels.ts` | `getToolAlias()`, `getBadgeStyles()`, `TOOL_ALIASES`, `getGroundedTargetName()` |
| `hooks/useTextInput.ts` | Shared text input handler |
| `hooks/useKeyboardHandlers.ts` | `useKeyboardHandlers()` — central keyboard routing + `OverlayStates` |
| `config/tui-config.ts` | `loadTuiConfig()` |
| `themes/registry.ts` | 2 themes (agency, daylight) |
| `motion/design-system.ts` | Motion identity — arc spinner, scan/energy bars, lifecycle + severity glyphs (single source of truth) |
| `motion/useTick.ts` | Frame counter hook |
| `motion/text.ts` | Spinner frames, typewriter math |
| `motion/terminal.ts` | `terminalBell()` |
| `motion/frameClock.ts` | `subscribeFrame()`, `getFrame()`, `frameMultiplier()` — shared frame clock |
| `motion/animations.ts` | `animationsEnabled()` — motion on/off gate |
| `motion/gradient.ts` | `lerpHex()`, `gradientTextColor()` — color interpolation |
| `terminal/screen.ts` | `enterAlternateScreen()` / `leaveAlternateScreen()` |

**Shared Components (Refactored):**
| File | Purpose |
|------|---------|
| `components/OverlayFooter.tsx` | Shared "↑↓ navigate · Enter select · Esc close" footer |
| `components/OverlayBox.tsx` | `Box borderStyle="round" borderColor={accent}` wrapper |
| `components/ListWindow.tsx` | Generic sliding-window list renderer |

**Screens (Scaffold):**
| File | Status |
|------|--------|
| `screens/Approval.tsx` | **Active** — full approval prompt |
| `screens/Sidebar.tsx` | Scaffold — not wired |
| `screens/Home.tsx` | Scaffold — not used |
| `screens/TaskRunner.tsx` | Scaffold — not used |
| `screens/Graph.tsx` | Scaffold — not used |
| `screens/Skills.tsx` | Scaffold — not used |
| `screens/Chat.tsx` | Scaffold — not used |

---

## 4. `@agency/providers` — LLM Provider Adapters

**Dependency:** `zod` only

### Files

| File | Purpose |
|------|---------|
| `types.ts` | `ProviderId`, `AgencyConfig`, `LlmProvider`, `ChatMessage`, `CompleteOptions` |
| `config.ts` | `loadAgencyConfig()`, `saveAgencyConfig()`, `configFilePath()`, `resolveApiKey()` — `~/.agency/config.json` with `${ENV_VAR}` resolution + atomic writes |
| `registry.ts` | `getProvider()` / `createProvider()` — factory dispatch |
| `thinking-spec.ts` | 23-model capability registry, `getModelThinkingConfig()`, variant generation |
| `token-optimizer.ts` | `optimizeForTask()` — intent-based budget/temp/token optimization, `detectFlop()` |
| `rate-limiter.ts` | `SmartRateLimiter` — sliding window, adaptive throttling, exponential backoff |
| `sse.ts` | `parseOpenAiSseBuffer()` — SSE delta parser |
| `error-parser.ts` | `isContextLimitError()`, `parseContextLimit()`, `estimateMessagesTokens()` — context-limit detection |
| `probe.ts` | `probeModel()`, `ProbeResult` — live model reachability/capability probe |
| `utils/errors.ts` | `isTransientError()` — transient vs fatal error classification |
| `models.ts` | `listAllModels()` — aggregates across 6 providers |
| `adapters/openai-compatible.ts` | Generic OpenAI-compatible driver (complete + streamComplete) |
| `openai.ts` | `createOpenAiProvider()` |
| `anthropic.ts` | `createAnthropicProvider()` — native Messages API |
| `google.ts` | `createGoogleProvider()` — native Gemini API |
| `openrouter.ts` | `createOpenRouterProvider()` |
| `nvidia.ts` | `createNvidiaProvider()` |
| `local.ts` | `createLocalProvider()` — Ollama |

### LLM Provider Registry (6 adapters)

| Provider | Base URL | Default Model |
|----------|----------|---------------|
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `anthropic` | Native Messages API | `claude-3-5-sonnet-20241022` |
| `google` | Native Gemini API | `gemini-2.0-flash` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `meta/llama3-70b-instruct` |
| `local` | `http://localhost:11434/v1` | `llama3.2` |

### Token Optimizer Intent Profiles

| Intent | Output% | Thinking% | Temperature |
|--------|---------|-----------|-------------|
| `search` | 30% | 5% | 0.2 |
| `tool_call` | 25% | 10% | 0.1 |
| `reasoning` | 80% | 50% | null |
| `generation` | 100% | 15% | null |
| `chat` | 50% | 25% | null |

### Cost Model Rates (per 1M tokens)

| Model Pattern | Input Rate | Output Rate |
|---|---|---|
| `claude-3-opus` / `opus` | $15.00 | $75.00 |
| `claude-3-5-sonnet` / `sonnet` | $3.00 | $15.00 |
| `gpt-4o` / `gpt-4-turbo` | $5.00 | $15.00 |
| `gemini-1.5-pro` / `gemini-pro` | $1.25 | $5.00 |
| `gemini-1.5-flash` / `flash` | $0.075 | $0.30 |
| Unknown/default | $0.15 | $0.60 |

---

## 5. `@agency/tooling` — JSON Repair & Tool Registry

**Dependencies:** `@agency/contracts`, `zod`

### Files

| File | Purpose |
|------|---------|
| `types.ts` | `ToolCall`, `ToolValidationResult`, `ToolDefinition<T>` |
| `json-repair.ts` | `JSONRepairEngine.repair()` — 5-pass LLM JSON fixer |
| `coercion-layer.ts` | `CoercionLayer.coerceJsonSchema()` / `coerceAndValidateZod()` |
| `plugin-supervisor.ts` | `PluginSupervisor` — watchdog-based child process supervision |
| `tool-registry.ts` | `ToolRegistry` — typed tool registry with Zod validation + hooks |

### JSONRepairEngine Repair Passes

1. Direct `JSON.parse` attempt
2. Extract from markdown fences (` ```json ... ``` `)
3. Remove trailing commas
4. Convert single-quoted keys to double-quoted
5. State-machine string repair + bracket balancing

### ToolRegistry Timeouts
| Category | Timeout |
|----------|---------|
| `read` | 10s |
| `write` | 30s |
| `compile` / `test` | 120s |
| `other` | 30s |

---

## 6. `@agency/workspace` — File Locking & Staging

**Dependency:** `execa`

### Files

| File | Purpose |
|------|---------|
| `types.ts` | `FileLock`, `StagedChange`, `WorkspaceTransaction` |
| `lock-manager.ts` | `LockManager` — per-file mutex with queuing, auto-release, deadlock prevention |
| `staging-engine.ts` | `StagingEngine` — virtual transaction staging with shadow-workspace verification |
| `recovery-engine.ts` | `RecoveryEngine` — backup, restore, git rollback, integrity verification |

### StagingEngine Lifecycle
1. `startTransaction()` → create active transaction
2. `stageFile()` → stage in memory
3. `verifyTransaction()` → shadow-workspace copy + `pnpm build` verification
4. `commitTransaction()` → atomic file writes
5. `discardTransaction()` → rollback

---

## 7. `@agency/context` — Context Degradation

**Zero dependencies.**

### Files

| File | Purpose |
|------|---------|
| `degradation.ts` | `degradeCode()` — strip function bodies; `degradeWorkspaceContext()` — tiered degradation |

### Degradation Tiers
- **Tier 1** (first file): kept fully intact
- **Tier 2** (subsequent files): function bodies collapsed to `{ /* collapsed */ }`

---

## 8. `@agency/memory` — SQLite Memory Subsystem

**Dependencies:** `@agency/governance`, `better-sqlite3`, `lru-cache`

### Files (19 modules)

| File | Purpose |
|------|---------|
| `types.ts` | 25-field `Episode`, `VectorEntry`, `GraphEdge`, `AuditEntry`, 9 memory states |
| `db.ts` | `getDb(projectRoot)` — WAL mode + shadow recovery |
| `migrations.ts` | v1 schema: 7 tables (episodes, vectors, graph_edges, event_log, audit_log, quarantined_vectors, episodes_fts) |
| `storage-backend.ts` | `SqliteStorageBackend` — full CRUD implementation |
| `write-queue.ts` | `WriteQueue` — serialized promise gate for SQLite |
| `ingestion.ts` | `IngestionPipeline` — text chunking + secret detection |
| `vector-store.ts` | `VectorStore.search()` — cosine similarity, dimension enforcement |
| `episodic-store.ts` | `EpisodicStore` — session/turn episodic memory |
| `graph-store.ts` | `GraphStore` — BFS shortest path, edge CRUD |
| `retriever.ts` | `HybridRetriever` — 5-phase pipeline: semantic → FTS → RRF → boosting → packing |
| `lifecycle.ts` | `CrdtMerger` (LWW-CRDT), `PolicyEngine` (TTL), `GraphIntegritySupervisor` (cycle breaking), `RecoverySupervisor` (shadow backup) |
| `cache.ts` | `MemoryCache<K,V>` — LRU (500 entries, 5min TTL) |
| `audit.ts` | `AuditLog` — mutation journal + rollback |
| `supervisor.ts` | `Supervisor` — retry with exponential backoff + quarantine |
| `governance.ts` | `MemoryBudgetAllocator` (heap-aware), `CapabilityNegotiator` (model-aware limits) |
| `security.ts` | `SecurityHardening` — AES-256-GCM encryption |
| `dashboard.ts` | `DashboardServer` — HTTP JSON API (port 8520) |
| `worker.ts` | Worker thread symbol parser |

### SQLite Schema (v1)

**Tables:** `episodes` (24 columns, FTS5-backed), `vectors` (JSON float arrays), `graph_edges` (BFS-capable), `event_log` (append-only), `audit_log` (pre/post snapshots), `quarantined_vectors`

### Retrieval Pipeline (HybridRetriever)
1. **Semantic Search** — `VectorStore.search()` with similarity threshold
2. **FTS Search** — `EpisodicStore.searchEpisodesByGoal()`
3. **RRF Fusion** — Reciprocal Rank Fusion: `1/(60 + rank)` for both vector + FTS
4. **Contextual Boosting** — recency decay, active task boost, edited files proximity
5. **Token-Budget Packing** — sequential by score until limit/maxTokens

---

## 9. `@agency/governance` — Cost & Provider Governance

**Zero dependencies.**

### Files

| File | Key Exports |
|------|------------|
| `cost-governance.ts` | `CostGovernor` — per-model cost tracking, 50%/75% warnings, budget ceiling, auto-downgrade |
| `provider-supervisor.ts` | `ProviderSupervisor` — health registry, latency tracking, failover at >50% failure rate |

---

## 10. `@agency/heuristics` — Loop Detection & Risk Tuning

**Zero runtime dependencies (uses `node:crypto`).**

### Files

| File | Key Exports |
|------|------------|
| `loop-heuristics.ts` | `LoopDetector` — 3 detection categories (identical errors, identical prompts, patch cycles) |
| `goal-anchor.ts` | `compileGoalPillars()`, `formatGoalAnchorPrompt()` — 🎯/🚫/✅ goals |
| `risk-refiner.ts` | `RiskHeuristicRefiner` — persists per-project risk adjustments to `.agency/risk-weights.json` |

---

## 11. `@agency/security` — Security Escalation & Sandbox

**Zero runtime dependencies.**

### Files

| File | Key Exports |
|------|------------|
| `security-escalation.ts` | `SecurityEscalationManager` — 5-level gating (Safe → Privileged), tool registry + fallback heuristic |
| `sandbox.ts` | `NativeSandbox`, `DockerSandbox`, `isDockerAvailable()` |
| `egress-proxy.ts` | `EgressFilterProxy`, `matchGlob()` — domain-allowlist network egress filtering |
| `process-jail.ts` | `ProcessJail` — restricts spawned child-process capabilities |
| `index.ts` | Security subsystem barrel |

### Security Levels

| Level | Name | Tools |
|-------|------|-------|
| 1 | Safe | `math`, `status`, `list_permissions` |
| 2 | ReadOnly | `view_file`, `list_dir`, `grep_search`, `read_resource` |
| 3 | WorkspaceWrite | `write_to_file`, `replace_file_content` |
| 4 | Network | `read_url_content`, `search_web`, `execute_url` |
| 5 | Privileged | `run_command` |

---

## 12. `@agency/skills-bridge` — Python Skills Pack Bridge

**Dependencies:** `@agency/core`, `execa`, `zod`

### Files

| File | Key Exports |
|------|------------|
| `registry.ts` | `loadPluginTools()` — parses `plugin-tools.json` with Zod validation |
| `runner.ts` | `runTool()`, `runBuiltinScript()`, `resolvePythonBin()` — executes Python via `execa`, resolving `python3`/`python`/`py` |
| `builtins.ts` | `BUILTIN_SCRIPTS` map (e.g., `prompt_route` → `prompt_router.py`) |
| `aliases.ts` | `SKILL_ALIASES` (~70 `$`-shortcuts, e.g. `$plan`, `$tdd`, `$gate`, `$verify`, `$debug`, `$finish`), `resolveSkillAlias()`, `aliasesForSkill()` |
| `loader.ts` | `loadManifestSkills()` — reads `manifest.json` |
| `skill-md.ts` | `parseSkillMd()` — YAML frontmatter + TL;DR extraction |

---

## 13. `@agency/benchmark` — Isolated Benchmarks

**Dependencies:** `@agency/core`, `@agency/telemetry`, `@agency/governance`

### Files

| File | Key Exports |
|------|------------|
| `types.ts` | `BenchmarkTask`, `BenchmarkResult` |
| `tasks.ts` | 3 default tasks: `fileAnalysisTask`, `astSearchTask`, `scriptCompilationTask` |
| `runner.ts` | `runBenchmarkTask()`, `runBenchmarkSuite()` — isolated workspace execution |
| `regression.ts` | `runRegressionReplay()` + `loadTraceFile()` — replay telemetry traces for regression detection (driven by `agency replay-regression`) |

---

## 14. `@agency/browser` — Browser Automation

**Zero mandatory deps (Playwright is optional peer).**

### Files

| File | Key Exports |
|------|------------|
| `types.ts` | `BrowserMode` (`"playwright" \| "cdp" \| "mock"`), `BrowserAutomationRuntime` interface |
| `runtime.ts` | `MockRuntime`, `PlaywrightRuntime`, `CdpRuntime`, `createBrowserRuntime(mode)` |

---

## 15. `@agency/telemetry` — Execution Tracing

**Zero dependencies.**

### Files

| File | Key Exports |
|------|------------|
| `types.ts` | `ToolTraceEntry`, `DeterministicExecutionTrace`, `TelemetryTracker` |
| `tracker.ts` | `ActiveTelemetryTracker` — record turns + tool calls |
| `replay.ts` | `ReplayEngine` — deterministic trace replay with deviation detection |

---

## 16. `@agency/cli` — Entry Point & Commands

**Dependencies:** `@agency/core`, `@agency/tui`, `@agency/skills-bridge`, `@agency/benchmark`, `commander`, `execa`

### Files

| File | Purpose |
|------|---------|
| `index.ts` | `#!/usr/bin/env node` entry — dispatches TUI or registers commands |
| `register.ts` | `registerCommands(program)` — aggregates all 26 command registrations |
| `tui-launch.ts` | `resolveTuiLaunch(argv)` — TUI vs headless decision logic |
| `resolve-project.ts` | `resolveProjectRoot()` — workspace root resolution |

### 26 Commands

| Command | File | Purpose |
|---------|------|---------|
| `agents` | `commands/agents.ts` | List / dispatch / parallel dispatch agents |
| `benchmark` | `commands/benchmark.ts` | Run isolated benchmarks |
| `browser` | `commands/browser.ts` | Browser MCP status + open URLs |
| `chat` | `commands/chat.ts` | Route + LLM response (optionally streaming) |
| `compact` | `commands/compact.ts` | Compress memory context |
| `config` | `commands/config.ts` | Init / show / path for `~/.agency/config.json` |
| `doctor` | `commands/doctor.ts` | TS-native preflight: Python, skills pack, provider keys (+ `--deep` pack health) |
| `eval` | `commands/eval.ts` | Run the eval suite + regression gate vs baseline |
| `git` | `commands/git.ts` | Git summary + PR status |
| `graph` | `commands/graph.ts` | Load knowledge graph |
| `handover` | `commands/handover.ts` | Generate `.agency/handover.md` resume digest |
| `index` | `commands/index-cmd.ts` | Build workspace file index |
| `memory` | `commands/memory.ts` | Memory status / build / genome |
| `plugin` | `commands/plugin.ts` | Validate / tools / schema for plugins |
| `replay` | `commands/replay.ts` | Replay + verify the durable event journal (§2.5) |
| `replay-regression` | `commands/replay-regression.ts` | Replay a recorded behaviour trace; `--baseline` checks a candidate reproduces the baseline's tool behaviour (§2.5) |
| `route` | `commands/route.ts` | Prompt routing only (no LLM call) |
| `routing` | `commands/routing.ts` | Manage routing weights + feedback |
| `run` | `commands/run.ts` | Execute shell commands with sandbox |
| `schedule` | `commands/schedule.ts` | Cron workflow scheduling |
| `setup` | `commands/setup.ts` | Bootstrap project setup |
| `skill` | `commands/skill.ts` | List / show / invoke skills |
| `status` | `commands/status.ts` | Runtime status: flags, events, memory, tasks, agents |
| `task` | `commands/task.ts` | Run / resume / abort plan tasks |
| `team` | `commands/team.ts` | Team configuration |
| `workflow` | `commands/workflow.ts` | List / run predefined workflows |

---

## Dependency Map

```
contracts ──────┐
                ├──→ tooling
heuristics ─────┤
governance ─────┼──→ memory
security ───────┤
context ────────┤
telemetry ──────┘
                    │
providers ─────────┼──→ core ──→ skills-bridge
workspace ─────────┤           ├──→ benchmark
                    │           └──→ tui ──→ cli
                    │
browser (standalone)
```

> `core` also depends on `@agency/telemetry` (a zero-dependency leaf) for §2.5 behaviour-trace recording (`chat/trace-recorder.ts`).

## Canonical Homes & No-Duplication Map

Single source of truth for shared logic, so new work **reuses** instead of
re-implementing. Before adding a helper, check whether its concern already has a
home here.

| Concern | Canonical home | Notes |
|---------|----------------|-------|
| Chat-turn setup (route resolve, key check, context repack), context compaction, turn token-cost estimate | `core/src/chat/turn-helpers.ts` | Shared by BOTH `runChatTurn` (orchestrator.ts) and `runChatTurnWithStream` (stream.ts). `recordTurnTokenCost` consolidated the once-copy-pasted `~len/4 + 200` estimate. |
| Headless output rendering | `OutputEngine` (`core/src/output/`) | CLI uses it via `out` / `handleError` in `cli/src/utils.ts`. Do NOT add ad-hoc `console.log` formatting in commands. |
| CLI process helpers (`out`, `exitOk/Fail`, `exitFromResult`, `writeProcessOutput`, `handleError`) | `cli/src/utils.ts` | One home for every command. |
| Tool-loop circuit breaking | `core/src/chat/circuit-breaker.ts` | Wired into `skill/tool-harness.ts`. The deleted `SkillsRegistry` per-skill breaker duplicated this. |
| Precise structural code edits (rename symbol, replace fn/method body, modify import, delete node) | `core/src/utils/ast-compiler.ts` (real TS AST) | Exposed to the model via the `ast_edit` tool in `skill/tool-harness.ts`; complements (not duplicates) `edit_file` text replace. Do NOT re-implement AST edits elsewhere. |
| "Which tools write files" (drives `filesWritten` → re-index + verify) | `isFileWritingTool` in `skill/tool-harness.ts` | Single source used by both orchestrator.ts + stream.ts; was an inlined `name === "write_file" || ...` check duplicated in both. |
| Plan / DAG execution | `core/src/task/runner.ts` (`runPlan`, `parsePlanTasks`, `detectDagCycle`) | The deleted `PlannerEngine` duplicated this on a separate `ExecutionDagContract` model. |
| Capability-driven agent routing + health/utilization | `core/src/agents/agent-registry.ts` | The deleted `DomainSpecialistRegistry` duplicated this. |
| Task/worker liveness — lease heartbeat, stall→fail, crash-resume | `LeaseManager` + `core/src/task/runner.ts` (`acquireLease`/`renewLease`/`checkExpired`) + `checkpoint.ts` + bootstrap auto-resume | The deleted `LongRunnerManager` duplicated this (plus SIGINT/SIGTERM shutdown, already live in tui/security/browser). A tier-6 *detached cross-process* runner, if ever built, belongs here on `LeaseManager`. |
| Durable event journal + replay verification | `core/src/events/event-journal.ts` + `events/replay-engine.ts` (`verifyJournalReplay`, `replaySessionJournal`) | Path convention lives only in `EventJournal.resolvePath`. |
| Behaviour-trace record/replay (§2.5) | record: `@agency/telemetry` `ActiveTelemetryTracker` (wired via `core/src/chat/trace-recorder.ts`); replay/regression: telemetry `ReplayEngine` + `@agency/benchmark` `runRegressionReplay`, driven by the `agency replay-regression` command (`cli/commands/replay-regression.ts`) | One trace format (`DeterministicExecutionTrace`). Don't build a second tracker/replayer/driver — extend these. The cli driver derives its types structurally from `runRegressionReplay` but declares `@agency/telemetry` (leaf) so tsc resolves the trace type. |
| Runtime cognition narration (`thought:emitted` for the TUI CognitionPanel) | `core/src/events/cognition.ts` `emitThought` (+ `emitVerifyRoundThought` for verify-loop rounds) | Single producer; the CognitionPanel (`tui/App.tsx`) is the single consumer. Gated centrally by `cognitionStream`. Don't publish `thought:emitted` ad-hoc — call `emitThought`. Emit points: routing (`resolveRoute`), safety gating (approval hook), capability reroute (`dispatchAgent`), verify self-heal (`runVerifyLoop` `onRound` → `emitVerifyRoundThought`, all 3 verify sites), compaction (`compactTurnHistory`). |
| Memory lifecycle / GC / secret redaction | `@agency/memory` | Flag-gated from core via setter (no core-flag import — avoids a dependency cycle). |
| Model catalog + cost resolution | `@agency/providers` (`model-catalog.ts`) + governance cost resolver | One price table; `matchModelKey` is shared with `resolveModelSpec`. |
| TUI severity glyph/colour | `tui/src/utils/severity.ts` (`thoughtSeverity*`) | Consolidated from CognitionPanel + ExecutionPanel. |
| Human `agency status` flag view | `cli/src/commands/status.ts` `buildFlagRows(flags)` | One declarative row-per-flag list (each row declares the flag keys it covers); `printHuman` just renders it. A completeness test asserts every `getRuntimeFlags()` key is covered, so no flag can be added without surfacing it. Don't hand-add `console.log` flag lines. `--json` emits the whole `getRuntimeFlags()` object. |

### Intentional name-collisions / near-duplicates — DO NOT merge

These look mergeable but are deliberately distinct; merging would change behaviour
or couple unrelated packages.

| Symbol / pattern | Why kept separate |
|------------------|-------------------|
| `ReplayEngine` — `core/src/events/replay-engine.ts` vs `telemetry/src/replay.ts` | Different domains: core verifies journaled events by hash; telemetry replays a `DeterministicExecutionTrace`, overriding live tool/clock outputs. Different packages. |
| `truncateText` — TUI vs core | TUI is terminal-width-aware; core is plain char-count. Different semantics. |
| `~len/4` token estimate — `providers/*` (`ceil`, rate-limiter), `memory/retriever.ts` (`ceil`, retrieval budget), `providers/error-parser.ts` (`round`), chat turn (`round + 200`) | Different formulas and domains; merging across packages would change behaviour and add cross-package deps. Only the orchestrator↔stream copy was byte-identical and now lives in `turn-helpers.recordTurnTokenCost`. |
| `handover.ts` — `core/runtime/handover.ts` vs `cli/commands/handover.ts` | Layer split: core builds the digest (`generateHandover`); cli is the thin command wrapper. |
| `grep_file` vs `grep_search` built-in tools (`skill/tool-harness.ts`) | Different scope: `grep_file` searches one file (the model passes a file path); `grep_search` walks the workspace recursively, honours the ignore filter, skips binaries, and supports `limit`/`case_sensitive`/`is_regex`. Complementary, not redundant — `grep_search` can't search a single file (it `readdirSync`s a directory). |
| `ToolCall` — `core/skill/tool-harness.ts` (`{name, arguments: Record<string,string>}`) vs `tooling/types.ts` (`{id, name, arguments: Record<string,any>}`) | Different shapes: core's is the parsed-XML model tool call (string args); tooling's is the registry-level call (carries an `id`, coerced `any` args). Distinct layers. |
| `GraphEdge` — `core/graph/loader.ts` (`{from,to,kind}`) vs `memory/types.ts` (`{source_id,target_id,relation_type,weight,metadata}`) | Different domains: the workspace code-dependency graph vs the memory knowledge graph. |
| `VerificationResult` — `core/skill/harness.ts` (`{passed,exitCode,stdout,stderr,error}`) vs `core/task/checkpoint.ts` (`{taskId,passed,timestamp,exitCode,stdout}`) | Different concerns: a tool-harness command result vs a persisted per-task checkpoint verification record. |
| `AuditEntry` — `core/approval/audit.ts` (`{action,tool,command,approved}`) vs `memory/types.ts` (full mutation record) | Different domains: the approval-gate audit line vs the memory mutation/rollback audit row. |
| Per-package `index.ts` / `types.ts` / `config.ts` / `runner.ts` / `registry.ts` | Normal monorepo structure — same basename, package-local scope, no shared logic. |

> `ChatMessage` (`{role, content}`) was a byte-identical duplicate in `core/chat/orchestrator.ts` and `providers/types.ts`; it is now **owned by `@agency/providers`** (the LLM layer) and re-exported from `orchestrator.ts` (`export type { ChatMessage }`) so the many `./orchestrator.js` consumers keep one import path with a single definition.

### Repeatable duplication scan

```bash
# Exported function/class names defined in >1 file (excluding tests):
grep -rEn --include='*.ts' "^export (async )?(function|class) [A-Za-z0-9_]+" packages/*/src \
 | grep -v "__tests__" \
 | sed -E 's#(.*):[0-9]+:export (async )?(function|class) ([A-Za-z0-9_]+).*#\4\t\1#' \
 | sort | awk -F'\t' '{n[$1]=n[$1]" "$2; c[$1]++} END {for (k in c) if (c[k]>1) print c[k]"  "k":"n[k]}'
```
As of 2026-06-01: the **function/class**-name scan's only cross-file match is the intentional `ReplayEngine` pair; the **exported-const** scan is empty; the **type/interface**-name scan matches `ToolCall`, `GraphEdge`, `VerificationResult`, `AuditEntry` (all intentionally distinct — see the table above) — `ChatMessage` was the one real duplicate and is now consolidated into `@agency/providers`. To also scan types, swap `(function|class)` for `(interface|type)` and `const` in the command above.

## Harness, built-in tools & skills (inventory)

So this doesn't get re-derived each session. Verified 2026-06-01.

### The turn harness (how a turn runs)
1. **Route** — `resolveRoute` (`chat/turn-helpers.ts`) → `routeUserPrompt` picks intent/workflow/agent/provider.
2. **Assemble prompt** — `buildSystemPrompt` (`chat/prompt.ts`) embeds the goal anchor, the tool protocol, and **`formatToolDocs()` which advertises tools dynamically from `registry.listTools()`** (register a tool ⇒ it's advertised automatically — no hardcoded list), the context pack, and historical memories.
3. **Model turn loop** — `runChatTurn` / `runChatTurnWithStream` run an outer tool loop (≤ `maxLoops`, default 15): the model emits XML `<tool_call name="…">…</tool_call>` blocks → `parseToolCalls` (`skill/tool-harness.ts`) → tools run (`Promise.all` over the batch; file-writing handlers are synchronous read-modify-write so they're atomic on Node's single thread) → each result is fed back as the next user message.
4. **Verify / self-heal** — file-editing turns are wrapped by the verify loop (`task/verify-loop.ts` `runVerifyLoop`) at the subagent dispatch sites and (for the one-shot CLI) the main turn (`chat/verify-turn.ts`); acceptance = build + (opt-in) lint/test.
5. **Compaction** — `compactTurnHistory` trims the middle of a long history before it overflows the window (flag `contextCompaction`).

### Built-in tools (single registry)
`registry = new ToolRegistry()` (from `@agency/tooling`) in `skill/tool-harness.ts` — **one registry**, no second tool table. 17 tools:

| Category | Tools |
|---|---|
| read | `read_file`, `list_dir`, `grep_file` (one file), `grep_search` (recursive), `find_files`, `file_info`, `git_summary`, `git_diff` |
| write (approval-gated) | `write_file`, `edit_file` (text replace), `ast_edit` (real-TS-AST structural; see Canonical Homes), `delete_file`, `move_file`, `create_directory`, `batch_edit` |
| compile | `execute_command` (sandboxed shell) |
| other | `dispatch_subagent` (spawns a specialist via the orchestrator) |

MCP tools register into the **same** registry with an `mcpSchema` marker and are approval-gated as external (MEDIUM-floored). "Which tools write files" → `isFileWritingTool` (single source; see Canonical Homes).

### Skills pack (bundled in `@agency/cli`)
- **Home:** `packages/cli/skills/` (shipped via the cli `files` field). Manifest: `.system/manifest.json`.
- **Contents (2026-06-01):** 28 skills (`codex-*` dirs, each a `SKILL.md`) + 8 agents (== `MANIFEST_AGENTS` in `core/agents/types.ts`) + 8 workflows + a `load_order` (always / on-demand). Two meta-skills live under `.system/` (`skill-creator`, `skill-installer`) and are intentionally not pack skills.
- **Loaders (skills-bridge):** `loadManifestSkills(root)`, `resolveSkillsRoot()` (core), `skillMdPath`, aliases (`SKILL_ALIASES`). Built-in helper scripts: `skills-bridge/builtins.ts` (`prompt_route`, `plugin_validate`, …).
- **Integrity guard:** `cli/__tests__/skills-manifest-integrity.test.ts` fails `pnpm verify` on any drift — manifest skill with no `SKILL.md` (advertised-but-missing), on-disk `SKILL.md` not in the manifest (built-but-unwired), `manifest.agents` ≠ `MANIFEST_AGENTS`, or a `load_order` entry that isn't a declared skill. **When adding/removing a skill or agent, update the manifest in the same change** or this test fails.

### Agent dispatch space
- **Source of truth:** `MANIFEST_AGENTS` (`core/agents/types.ts`) — the 8 dispatchable agents. Three maps must stay in lockstep with it:
  - `AGENT_SUBAGENT_PROMPT` (`core/agents/profiles.ts`) — agent → prompt template under `codex-subagent-execution/agents/` (`implementer-prompt.md` for 7, `code-quality-reviewer-prompt.md` for `security-auditor`; `spec-reviewer-prompt.md` also ships but is an unmapped optional template for custom agents). Resolved by `subagentPromptPath` (project-local `.agency/agents/<file>` override first, then the bundled pack).
  - capability seeds (`core/agents/agent-registry.ts` `AGENT_SEEDS`, the live `capabilityRegistry`) — per-agent capabilities/clearance for routing. No seed ⇒ router sees "no-capability-signal".
  - `AGENT_DISCIPLINES` (`profiles.ts`) — discipline skills surfaced after dispatch; each must be a declared manifest skill.
- **Integrity guard:** `core/__tests__/agent-dispatch-integrity.test.ts` fails `pnpm verify` if `AGENT_SUBAGENT_PROMPT` keys, the capability-seed ids, or `MANIFEST_AGENTS` drift apart, if a mapped prompt template is missing on disk, or if a discipline skill isn't declared. **Adding an agent means: add it to `MANIFEST_AGENTS` + the manifest `agents` + `AGENT_SUBAGENT_PROMPT` + an `AGENT_SEEDS` seed** (and ship the prompt file) — all in one change.
