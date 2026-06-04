# Agency CLI — Testing Infrastructure

## Framework

**Vitest v2.1** is the sole testing framework across all packages. No Jest, Mocha, or other test runners.

## Test Configuration

### Packages with `vitest.config.ts`

| Package | Test Files | Tests (Vitest runtime) |
|---------|-----------|-------|
| `@agency/providers` | 11 | 831 |
| `@agency/cli` | 15 | 547 |
| `@agency/core` | 49 | 266 |
| `@agency/tui` | 25 | 113 |
| `@agency/security` | 6 | 35 |
| `@agency/memory` | 7 | 25 |
| `@agency/skills-bridge` | 5 | 14 (1 skipped) |
| `@agency/tooling` | 2 | 10 |
| `@agency/context` | 1 | 6 |
| `@agency/heuristics` | 1 | 6 |
| `@agency/workspace` | 1 | 6 |
| `@agency/benchmark` | 1 | 6 |
| `@agency/browser` | 1 | 5 |
| `@agency/telemetry` | 1 | 4 |
| `@agency/governance` | 1 | 3 |
| `@agency/contracts` | 0 | 0 |

**Total: run `pnpm verify` (= `pnpm -r build && pnpm -r test`) for the live count across all 16 packages — the single source of truth. The per-package numbers above are an illustrative snapshot and drift every slice; the ROADMAP §8 banner carries the latest totals.**

> The "Tests" column is the count Vitest reports at runtime. Several suites generate tests programmatically inside loops — `@agency/providers` (831, across the 23-model thinking-spec matrix) and `@agency/cli`'s `native-harness.test.ts` (520 in one file) — so the runtime count is far higher than a static count of `it()` literals in the source.

### Test File Naming

```
src/__tests__/<name>.test.ts   — logic tests
src/__tests__/<name>.test.tsx  — React/Ink component tests
```

## Test Patterns by Package

### 1. Core Tests (`packages/core/src/__tests__/`)

**49 test files, 266 tests** — the broadest hand-written coverage.

| Test Category | Files | What's Tested |
|--------------|-------|---------------|
| Orchestration & Routing | `model-router.test.ts`, `orchestrator.test.ts`, `prompt-bridge.test.ts`, `routing-weights.test.ts` | Route resolution, weight application, feedback learning, Python bridge integration |
| Task & Plan | `task-runner.test.ts`, `dag-checkpoint-integrity.test.ts`, `approval-policy.test.ts` | Plan parsing, checkpoint save/load, DAG cycle detection, autonomy escalation |
| Approval & Security | `approval.test.ts`, `approval-policy.test.ts`, `sandbox-routing.test.ts` | 23 DENY_PATTERNS, risk assessment, continuation policies, sticky denials |
| Context | `pack.test.ts`, `file-refs.test.ts`, `token-policy.test.ts`, `compact.test.ts` | Context assembly, @-reference resolution, token budgets |
| Events & Journal | `event-bus.test.ts`, `replay-journal.test.ts` | Pub/sub, dedup, SQLite journal replay |
| Agents | `agents-orchestrator.test.ts`, `workspace-isolation.test.ts` | Agent dispatch, workspace isolation, parallel merge |
| Other | `chat-stream.test.ts`, `chat-presentation.test.ts`, `mcp.test.ts`, `workflow-compose.test.ts`, `harness.test.ts`, `tool-harness.test.ts`, `output-engine.test.ts`, `ast-compiler.test.ts`, etc. | Streaming, presentation, MCP, workflow chains, skill/tool harness, output engine, AST patching |

**Patterns:**
- Heavy use of `mkdtempSync` + `rmSync` for filesystem isolation
- Mocking `vi.fn()` for external calls (fetch, child_process)
- `@agency/memory` tests use `:memory:` SQLite for speed

### 2. CLI Tests (`packages/cli/src/__tests__/`)

**15 test files, 547 tests** — `native-harness.test.ts` alone generates 520 of them in loops.

| Test | Approach |
|------|----------|
| `index.test.ts`, `route.test.ts`, `chat.test.ts`, etc. | **Integration tests** — spawn the actual built binary via `spawnSync` |
| `tui-launch.test.ts` | **Unit tests** — `resolveTuiLaunch()` decision logic |
| `native-harness.test.ts` | Comprehensive skill alias, workflow, agent, and plugin verification — a handful of `it()` blocks each looping over **hundreds of cases/assertions** |

**Pattern:** Every CLI test:
1. Creates a temp directory (`mkdtempSync`)
2. Optionally writes test files (package.json, source files)
3. Spawns `node dist/index.js <command> <args>` via `spawnSync`
4. Asserts exit code, stdout/stderr content
5. Cleans up temp directory

### 3. TUI Tests (`packages/tui/src/__tests__/`)

**25 test files, 113 tests** — uses `ink-testing-library`.

| Category | Files | Approach |
|----------|-------|----------|
| Component rendering | `chat.test.tsx`, `shell.test.tsx`, `connect.test.tsx` | `render(<Component/>)` → `lastFrame()` → assert text |
| Motion & animation | `animations.test.ts`, `text.test.ts`, `gradient.test.ts`, `design-system.test.ts`, `frame-clock.test.ts` | Pure function tests (no React) |
| Utilities | `text.test.ts`, `file-parser.test.ts`, `sessions.test.ts`, `sanitize.test.ts` | Vietnamese grapheme handling, file edit parsing |
| Slash & presentation | `slash.test.ts`, `slash-menu.test.ts`, `turn.test.ts`, `system-notice.test.ts` | Command parsing, menu filtering |
| Layout | `terminal-layout.test.ts` | `measureTerminal()` pure math |

**`ink-testing-library` usage:**
```typescript
import { render } from "ink-testing-library";
const { lastFrame, stdin } = render(<Component theme={theme}/>);
expect(lastFrame()).toContain("expected text");
stdin.write("y"); // simulate key press
```

### 4. Memory Tests (`packages/memory/src/__tests__/`)

**7 test files, 25 tests.**

| Test | Scope |
|------|-------|
| `memory-unit.test.ts` | 8 tests — DB init, episode CRUD, FTS5, vector similarity, AST chunking, encryption, cache |
| `memory-concurrency.test.ts` | 1 test — 15 concurrent writes via WriteQueue |
| `memory-invariants.test.ts` | 5 tests — TTL policies, LWW-CRDT, graph cycles, RRF fusion |
| `memory-migrations.test.ts` | 1 test — forward + rollback |
| `memory-recovery.test.ts` | 2 tests — shadow backup + auto-restore |
| `memory-replay.test.ts` | 1 test — event sourcing + replay |
| `chaos-stress.test.ts` | 6 tests — 1000 writes, ENFILE/ENOSPC, WAL corruption, cost ceilings |

**Pattern:** In-memory SQLite (`:memory:`) for isolation and speed.

### 5. Provider Tests (`packages/providers/src/__tests__/`)

**11 test files, 831 tests** — most are generated across the 23-model thinking-spec matrix.

| Test | Scope |
|------|-------|
| `models.test.ts` | Model listing |
| `thinking-spec.test.ts` | Model specs, variant generation |
| `rate-limiter.test.ts` | Rate limiting + adaptive throttling |
| `token-optimizer.test.ts` | Intent inference, token optimization |
| `sse.test.ts` | SSE delta parsing |
| `config.test.ts` | Config loading, env var resolution |
| `registry.test.ts` | Provider factory + resolution |
| `openai-compatible.test.ts` | Generic adapter |
| `anthropic.test.ts` | Native Anthropic Messages adapter |
| `google.test.ts` | Native Gemini adapter |
| `probe.test.ts` | Model reachability probe |

## Running Tests

```bash
# All packages
pnpm -r test

# Single package
cd packages/core && pnpm test

# Single file
cd packages/core && npx vitest run src/__tests__/approval.test.ts

# Specific test
cd packages/core && npx vitest run -t "should detect destructive commands"

# Watch mode
cd packages/tui && npx vitest
```

## Test Coverage Gaps

### Packages with zero tests
- `@agency/contracts` — pure type definitions (0 tests)

### Under-tested modules (each has only 1 catch-all test)

| Package | Missing Coverage |
|---------|-----------------|
| **tooling** | `json-repair.ts`, `coercion-layer.ts`, `plugin-supervisor.ts` |
| **workspace** | `staging-engine.ts`, `recovery-engine.ts`, `lock-manager.ts` |
| **heuristics** | `goal-anchor.ts`, `risk-refiner.ts` |
| **governance** | `cost-governance.ts`, `provider-supervisor.ts` |

### Under-tested TUI components (42 components, ~12 tested)

| Tested (directly or via render smoke) | Not Tested |
|--------|-----------|
| Conversation, Chat, Shell, Connect, extractFileChanges (+ harness/production render smoke) | App.tsx, Splash, WelcomeMenu, GoalRunner, ModelsOverlay, McpOverlay, StatusDashboard, SkillsPicker, Approval, RouteOverlay, +20 more |

## Writing New Tests

### For a core module
```typescript
import { describe, expect, it, vi } from "vitest";
import { yourFunction } from "../path/to/module.js";

describe("your module", () => {
  it("does something", () => {
    expect(yourFunction("input")).toBe("expected");
  });
});
```

### For a CLI command
```typescript
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

describe("agency your-command", () => {
  it("works", () => {
    const dir = mkdtempSync("test-");
    writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "test" }));
    const result = spawnSync("node", ["dist/index.js", "your-command", "--project-root", dir]);
    expect(result.status).toBe(0);
    rmSync(dir, { recursive: true });
  });
});
```

### For a TUI component
```typescript
import { render } from "ink-testing-library";
import { YourComponent } from "../components/YourComponent.js";

describe("YourComponent", () => {
  it("renders", () => {
    const { lastFrame } = render(<YourComponent theme={theme} />);
    expect(lastFrame()).toContain("expected text");
  });
});
```

### For memory/SQLite
```typescript
import { getDb } from "../db.js";

describe("memory test", () => {
  it("works", () => {
    const db = getDb("/tmp/test", ":memory:");
    // ... test SQLite operations
    db.close();
  });
});
```

## Smoke Test Pipeline

`scripts/smoke.ps1` runs a 7-step verification:
```
1. pnpm -r build        — TypeScript compilation
2. pnpm -r test         — All test suites
3. agency setup         — Project bootstrap
4. agency doctor        — Pack health check
5. agency config init   — Config creation
6. agency route "hello" — Prompt routing
7. agency agents list   — Agent enumeration
```
