# Agency CLI — Telemetry, Replay & Benchmarking

## Overview

Three packages form the observability stack: `@agency/telemetry` records everything an agent does, `@agency/benchmark` runs isolated performance tests, and together they enable deterministic replay and regression detection.

---

## Telemetry (`@agency/telemetry`)

**Location:** `packages/telemetry/src/`

### Data Model

| Type | Purpose |
|------|---------|
| `ToolTraceEntry` | Single tool invocation: `toolName`, `arguments`, `output`, `timestamp` |
| `DeterministicExecutionTrace` | Full agent session: `sessionId`, `goal`, `initialGitHash`, `providerSeed`, `timings[]`, `toolOutputs[]` |
| `TelemetryTracker` | Interface contract: `startSession()`, `recordTurn()`, `recordToolCall()`, `exportTrace()` |

### ActiveTelemetryTracker (`tracker.ts`)

In-memory recorder that accumulates during agent execution:

```typescript
const tracker = new ActiveTelemetryTracker();

// Record a turn (prompt → response timing)
tracker.startSession("session-1", "Fix auth bug", { gitHash: "abc123", providerSeed: 42 });
tracker.recordTurn("Fix login", 1234 /* ms */, 567 /* tokens */);

// Record a tool invocation
tracker.recordToolCall("write_to_file", { path: "src/login.ts" }, "success", 450 /* ms */);

// Export for replay
const trace = tracker.exportTrace();
// → DeterministicExecutionTrace
```

### ReplayEngine (`replay.ts`)

Consumes a trace and replays it deterministically:

```typescript
const engine = new ReplayEngine(trace);

// Simulate turn timing
const duration = engine.nextTurnDuration(); // → 1234 (from recorded timing)

// Intercept tool calls with fuzzy matching
const result = engine.interceptToolCall("write_to_file", { path: "src/login.ts" });
// → Returns recorded output if found, throws if deviation detected

// Check for unconsumed outputs (regression detection)
engine.getUnconsumedCount(); // → 0 means all predicted outputs were consumed
```

**Key feature:** `interceptToolCall()` uses deep-equality fuzzy matching on arguments. If the agent tries a tool call that wasn't in the recorded trace, the engine throws — catching behavioral drift.

---

## Benchmark (`@agency/benchmark`)

**Location:** `packages/benchmark/src/`

### Data Model

| Type | Purpose |
|------|---------|
| `BenchmarkTask` | `id`, `name`, `objective`, optional `setup()`, required `validate()`, optional `cleanup()` |
| `BenchmarkResult` | `taskId`, `success`, `durationMs`, `costUsd`, optional `error` |

### Default Tasks (`tasks.ts`)

| Task | Setup | Validation |
|------|-------|-----------|
| `fileAnalysisTask` | Creates `src/index.ts` with `hello()` export | Verifies export exists |
| `astSearchTask` | Creates `src/helper.ts` with 2 arrow functions | Counts `=>` matches = 2 |
| `scriptCompilationTask` | Creates TypeScript file + `tsconfig.json` | Verifies `dist/main.js` produced |

### Runner (`runner.ts`)

```typescript
// Run single task in isolated workspace
const result = await runBenchmarkTask(projectRoot, fileAnalysisTask, {
  skillsRoot,
  budget: 5.0 // USD
});
// → { taskId, success, durationMs, costUsd }

// Run full suite
const results = await runBenchmarkSuite(projectRoot, defaultTasks, opts);
```

Each task runs in a **completely isolated workspace** created by `@agency/core`:
1. Create temp directory
2. Copy workspace (excluding node_modules, .git, .agency)
3. Run `setup()`
4. Run `validate()` with `CostGovernor` budget tracking
5. Run `cleanup()`
6. Clean temp directory (always, even on failure)

### Regression Testing (`regression.ts`)

```typescript
// Load a recorded trace
const trace = await loadTraceFile("/path/to/trace.json");

// Replay against an executor
const result = await runRegressionReplay(trace, async (engine) => {
  // Simulate agent execution using engine for timing + tool interception
  for (let i = 0; i < trace.timings.length; i++) {
    await engine.nextTurnDuration();
    // ... agent logic ...
    engine.interceptToolCall("write_to_file", args);
  }
});
// → { success, turnsReplayed, unconsumedOutputs, error? }
```

**Success criterion:** All recorded tool outputs must be consumed by the agent during replay. Unconsumed outputs = behavioral regression.

---

## CLI Integration

### Benchmark Commands

```bash
# List available benchmark tasks
agency benchmark --list                          # Table format
agency benchmark --list --json                   # JSON format

# Run all benchmarks
agency benchmark                                 # Full suite

# Run specific task
agency benchmark file-analysis                   # Single task
agency benchmark file-analysis --json            # JSON output

# Budget control
agency benchmark --budget 10.0                   # Max $10.00 spend
```

### Benchmark Output

```
Task               Success  Duration    Cost     
file-analysis      ✓        234ms       $0.0012  
ast-search         ✓        156ms       $0.0008  
script-compilation  ✓       1890ms      $0.0045  

Total: 3/3 passed, $0.0065, 2280ms
```

---

## Smoke Test Integration

`scripts/smoke.ps1` includes a full pipeline verification:
1. Build → test → setup → doctor → config
2. Route prompt → verify routing works
3. Agent enumeration → verify all agents registered

## Deterministic Replay Use Cases

1. **Regression Detection** — Replay a trace from CI against local changes; unconsumed outputs = regression
2. **Debugging** — Replay a problematic session with breakpoints to inspect agent decisions
3. **Performance Profiling** — Compare execution timing across builds using recorded `timings[]`
4. **Cost Attribution** — Track exact token usage and cost per agent session
5. **Reproducible Testing** — Use recorded traces as test fixtures with known-good outputs

## Cost Governance Integration

Both telemetry and benchmark integrate with `@agency/governance`:
- `CostGovernor` tracks spending per benchmark run
- Budget ceiling enforced (default $5.00, configurable)
- Auto-downgrade at 75% usage

## Adding a Custom Benchmark Task

```typescript
const myTask: BenchmarkTask = {
  id: "my-custom-task",
  name: "Custom Test",
  objective: "Verify that agent can navigate and extract data",
  setup: async (workspace) => {
    // Create test files in the isolated workspace
    const fs = await import("node:fs");
    fs.writeFileSync(`${workspace}/src/data.ts`, "export const data = [1,2,3];");
  },
  validate: async (workspace) => {
    // Run validation — return true/false
    // Can use runChatTurn, runShellCommand, etc.
    const result = await runChatTurn({
      prompt: "Extract the data array from src/data.ts",
      projectRoot: workspace,
      skillsRoot,
    });
    return result.assistantText.includes("[1,2,3]");
  },
  cleanup: async (workspace) => {
    // Optional cleanup (temp dir is auto-deleted anyway)
  },
};
```
