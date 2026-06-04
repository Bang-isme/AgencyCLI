# Agency CLI — Development Guide

## Prerequisites

- **Node.js ≥22** (ES2022, ESM, NodeNext)
- **pnpm ≥9.0.0** (workspace management)
- **Python 3.x** (for skills pack scripts)
- **PowerShell** (Windows CI scripts)
- **Docker** (optional — for sandboxed shell execution)

## Repository Structure

```
AgencyCLI/
├── packages/              # 16 packages (monorepo)
│   ├── contracts/         # Shared types (private, never published)
│   ├── heuristics/        # Loop detection, goal anchoring
│   ├── governance/        # Cost budget, provider health
│   ├── context/           # Context degradation engine
│   ├── security/          # Security escalation + sandbox
│   ├── telemetry/         # Execution tracing + replay
│   ├── providers/         # LLM adapters (6 providers)
│   ├── workspace/         # File locking + staging
│   ├── tooling/           # JSON repair + schema coercion
│   ├── memory/            # SQLite episodic + vector memory
│   ├── core/              # Central orchestration hub
│   ├── skills-bridge/     # Python skills pack bridge
│   ├── tui/               # React/Ink terminal UI
│   ├── browser/           # Playwright/CDP automation
│   ├── benchmark/         # Isolated benchmark runner
│   └── cli/               # Entry point + 26 Commander commands
├── docs/                  # System documentation
├── scripts/               # PowerShell CI scripts
├── tests/                 # Test fixtures
├── tsconfig.base.json     # Shared TypeScript base config
├── pnpm-workspace.yaml    # pnpm workspace definition
└── package.json           # Root package (private)
```

## Build System

### TypeScript Configuration

Every package extends `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "rootDir": "src",
    "outDir": "dist"
  }
}
```

**Key decisions:**
- **Pure `tsc`** — no bundler (esbuild, rollup, webpack)
- **ESM only** — all imports use `.js` extensions
- **Project references** — `composite: true` with explicit `references: [...]` per package
- **No emit on error** — strict mode guarantees runtime correctness

### Build Commands

```bash
# Build all packages in dependency order
pnpm -r build

# Build single package
cd packages/core && pnpm build

# Watch mode (single package)
cd packages/tui && tsc -p tsconfig.json --watch
```

### Package Dependencies

Bottom-tier packages have zero or minimal dependencies:

| Package | Runtime Dependencies |
|---------|---------------------|
| `contracts` | *(none)* |
| `context` | *(none)* |
| `governance` | *(none)* |
| `heuristics` | `node:crypto` only |
| `security` | *(none)* |
| `telemetry` | *(none)* |
| `providers` | `zod` |
| `workspace` | `execa` |
| `tooling` | `@agency/contracts`, `zod` |
| `memory` | `@agency/governance`, `better-sqlite3`, `lru-cache` |
| `browser` | *(none; Playwright is optional peer)* |
| `core` | 8 sibling packages + `better-sqlite3`, `execa`, `zod` |
| `skills-bridge` | `@agency/core`, `execa`, `zod` |
| `tui` | `@agency/core`, `@agency/providers`, `ink`, `react` |
| `benchmark` | `@agency/core`, `@agency/telemetry`, `@agency/governance` |
| `cli` | `@agency/core`, `@agency/tui`, `@agency/skills-bridge`, `@agency/benchmark`, `commander`, `execa` |

## Development Workflow

### 1. Setup

```bash
git clone <repo-url>
cd AgencyCLI
pnpm install
pnpm -r build
```

### 2. Running

```bash
# TUI mode (interactive)
pnpm agency

# Headless mode
pnpm agency chat "Hello"
pnpm agency route "Fix auth bug"
pnpm agency run "npm test"
```

### 3. Testing

```bash
# ▶ THE ground-truth gate — build all 16 packages + run the full test suite.
#   Run this before claiming "green" or committing a change. Don't assert green — verify it.
pnpm verify            # = pnpm -r build && pnpm -r test

# Run all tests only
pnpm -r test

# Run single package
cd packages/core && pnpm test

# Run single test file
cd packages/core && npx vitest run src/__tests__/approval.test.ts

# Watch mode
cd packages/tui && npx vitest
```

> **Rule (load-bearing):** this repo has a history of handoffs that *claimed* "build clean / all green"
> when the tree was actually broken. The single authoritative check is **`pnpm verify`**, also enforced by
> `.github/workflows/ci.yml` on push/PR. If you didn't run it, you don't know it's green.

### 4. Linting & Type Checking

```bash
# Type-check all packages
pnpm -r build

# Type-check single package
cd packages/core && npx tsc --noEmit
```

### 5. Configuration

```bash
# Create config from template, then inspect/edit from the CLI
agency config init
agency config path                       # print the config file location
agency config show                       # print config (API keys masked)
agency config set defaultProvider openai
agency config set providers.openai.apiKey '${OPENAI_API_KEY}'
agency config unset providers.openai

# Files
# ~/.agency/config.json       — global LLM config
# ~/.agency/tui.json          — global TUI config
# ~/.agency/mcp.json          — global MCP config
# $PROJECT/.agency/*          — project-specific state
```

## Key Conventions

### Architecture Patterns

| Pattern | Description |
|---------|-------------|
| **Bottom-tier zero-deps** | `heuristics`, `governance`, `security`, `context`, `telemetry` have zero inter-package deps |
| **Barrel exports** | Every package has `index.ts` re-exporting all public symbols |
| **Commander registration** | Every CLI command exports `registerXxxCommand(program)` called from `register.ts` |
| **@-style imports** | All packages use `@agency/xxx` imports (workspace protocol) |
| **Python bridge (read-only)** | Skills pack scripts are never modified; all interaction via `execa` + `plugin-tools.json` |

### Naming Conventions

| Convention | Example |
|------------|---------|
| Test files | `src/__tests__/foo.test.ts` (logic), `foo.test.tsx` (React) |
| Commands | `commands/<name>.ts` with `registerXxxCommand(program)` |
| Components | PascalCase: `ComposerBlock.tsx`, `GoalRunner.tsx` |
| Hooks | camelCase with `use` prefix: `useTick.ts`, `useTextInput.ts` |
| Utilities | lowercase kebab: `text.ts`, `file-parser.ts` |

### File Organization

- **`src/`** — all source code (tests alongside: `src/__tests__/`)
- **`dist/`** — compiled output (gitignored)
- **`.agency/`** — runtime state (gitignored)
- **`skills/`** — vendored CodexAI skills pack (in `packages/cli/`)

## Adding a New Package

1. Create directory: `packages/new-package/`
2. Create `package.json` with `@agency/new-package` name
3. Create `tsconfig.json` extending base, with `composite: true`
4. Create `src/index.ts` as barrel
5. Add to `pnpm-workspace.yaml` (if needed — glob pattern `packages/*` covers it)
6. If other packages need it: add `"@agency/new-package": "workspace:*"` to their `package.json`
7. If it depends on others: add `"references": [...]` in `tsconfig.json`
8. Run `pnpm install` from root

## Adding a New CLI Command

1. Create `packages/cli/src/commands/<name>.ts`
2. Export `registerXxxCommand(program: Command)` — use Commander's `.command()`, `.option()`, `.action()`
3. Import and call from `packages/cli/src/register.ts`
4. Write tests in `packages/cli/src/__tests__/<name>.test.ts` — use `spawnSync` for integration tests

## Adding a New TUI Component

1. Create `packages/tui/src/components/<Name>.tsx`
2. Export the component as default or named export
3. Add theme prop: `theme: ThemeTokens`
4. Use `useTerminalLayout()` for responsive sizing
5. Write tests with `ink-testing-library`: `render(<Component/>)`, `lastFrame()`, `stdin.write()`

## Adding a New LLM Provider

1. Create `packages/providers/src/<name>.ts`
2. Export a `createXxxProvider(profile, fetchImpl?)` function returning `LlmProvider`
3. Add to `providers/src/registry.ts` factory map
4. Add `ProviderId` union type in `types.ts`
5. Add config template defaults in `config.ts`
6. Add model specs in `thinking-spec.ts`

## CI/CD Scripts

Located in `scripts/` directory:

| Script | Purpose |
|--------|---------|
| `smoke.ps1` | Full pipeline: build → test → setup → doctor → config → route → agents |
| `pack-local.ps1` | Pack all packages for local testing |
| `dogfood.ps1` | Self-test: run Agency against its own repo |
| `publish.ps1` | Publish packages to npm registry |
| `install.ps1` | Install Agency CLI globally |
| `version-bump.ps1` | Bump version across all packages |

## Running Smoke Tests

```powershell
# Windows
.\scripts\smoke.ps1

# The smoke test does:
# 1. pnpm -r build
# 2. pnpm -r test
# 3. agency setup
# 4. agency doctor
# 5. agency config init
# 6. agency route "hello"
# 7. agency agents list
```

## Common Issues

### "Cannot find module './something.js'"
Run `pnpm -r build` to rebuild all packages. ESM requires `.js` extensions even for TypeScript imports.

### "Module not found: @agency/xxx"
Check that `@agency/xxx` is in the package's `package.json` dependencies as `"workspace:*"`.

### Type errors after adding a new export
Check that the symbol is re-exported from the package's `index.ts` barrel.

### SQLite database locked
Multiple concurrent writes to `.agency/memory/memory.db` — the `WriteQueue` serializes writes, but if you're running multiple agency processes, only one can write at a time.
