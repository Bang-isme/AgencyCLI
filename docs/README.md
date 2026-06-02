# Agency CLI — Documentation

> **Picking up this repo for ongoing work?** Start with the paste-in onboarding
> prompt [SESSION_HANDOFF_PROMPT.md](./SESSION_HANDOFF_PROMPT.md) and the current
> frontier in [NEXT_SESSION_PROMPT.md](./NEXT_SESSION_PROMPT.md) (see the
> Process & Continuity index below).

## Overview

Agency CLI is a monorepo AI agent CLI tool with an interactive terminal UI (React/Ink) and a headless CLI mode. It orchestrates LLM providers, prompt routing, task planning, agent dispatch, and file editing with approval gates. (For live counts — packages, tests, flags, tools — run `pnpm verify` and `agency status` rather than trusting any number written in docs.)

## Documentation Index

### Architecture & Design

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Monorepo structure, dependency graph, layered architecture, build system, 8 design patterns |
| [CORE_ENGINE.md](./CORE_ENGINE.md) | Deep dive into 19 core subsystems: routing, chat, providers, context, approval, tasks, agents, workflows, planner, events, memory, governance, security, output engine, MCP runtime |
| [UI_DESIGN.md](./UI_DESIGN.md) | Complete TUI design: phase flow, component tree (42 components), layout system, themes, animation (152-line design system), input architecture, 13 overlays, 20+ slash commands, state architecture |
| [CONFIG_AND_STATE.md](./CONFIG_AND_STATE.md) | All persistence backends: config files, 2 SQLite databases, in-memory state, 4 cache layers, session lifecycle, API key management |
| [PACKAGES.md](./PACKAGES.md) | **Complete package reference** — every export, every module, every function across all 16 packages |

### Operations

| Document | Description |
|----------|-------------|
| [CLI_REFERENCE.md](./CLI_REFERENCE.md) | Complete command reference: 21 headless commands and 20+ TUI slash commands with all options |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Development guide: build system, conventions, adding packages/commands/components/providers, CI/CD scripts |
| [TESTING.md](./TESTING.md) | Test infrastructure: 127 test files, ~1,876 tests across 15 packages, patterns per package, coverage gaps |

### Security & Safety

| Document | Description |
|----------|-------------|
| [SECURITY_MODEL.md](./SECURITY_MODEL.md) | Defense-in-depth: 3-layer security (approval policy + security escalation + sandboxing), risk assessment, audit trail, memory encryption, secret detection, loop detection |

### Systems

| Document | Description |
|----------|-------------|
| [SKILLS_PACK.md](./SKILLS_PACK.md) | Skills pack system: 28 skills, 8 agents, 8 workflows, 14 system scripts, Python bridge architecture, aliases, SKILL.md format, execution safety |
| [TELEMETRY_BENCHMARK.md](./TELEMETRY_BENCHMARK.md) | Telemetry tracing, deterministic replay engine, isolated benchmarking, regression detection |

### Process & Continuity (for ongoing work)

| Document | Role | Edit policy |
|----------|------|-------------|
| [SESSION_HANDOFF_PROMPT.md](./SESSION_HANDOFF_PROMPT.md) | The rulebook + paste-in onboarding prompt (read order, anti-dup, verify, flags, slice rhythm) | Living |
| [ROADMAP_HANDOFF.md](./ROADMAP_HANDOFF.md) | Live work map (`TRUTH → BUG → FIX`), §8 is current | Living — update in the same slice |
| [NEXT_SESSION_PROMPT.md](./NEXT_SESSION_PROMPT.md) | Paste-in prompt: current frontier + next tasks | Living snapshot |
| [HARDENING_HANDOFF.md](./HARDENING_HANDOFF.md) | Production-hardening campaign status + per-slice `cont'd N` log | Living (append) |
| [EVAL_RESULTS.md](./EVAL_RESULTS.md) | BYOK eval results (legacy ↔ hardened) | Living (append) |
| [PRODUCTION_AUDIT.md](./PRODUCTION_AUDIT.md), [PRODUCTION_AUDIT_APPENDIX.md](./PRODUCTION_AUDIT_APPENDIX.md) | Point-in-time audit | **Frozen — do not edit** |

## Quick Start

```bash
# Install
pnpm install

# Build all packages
pnpm -r build

# Run TUI (interactive mode)
pnpm agency

# Or via alias
pnpm acg

# Headless command
pnpm agency chat "Hello, what can you do?"

# Run tests
pnpm -r test
```

## Package Inventory (16 packages)

| Package | Layer | Purpose |
|---------|-------|---------|
| `@agency/cli` | Entry | Binary, Commander subcommands, TUI/headless dispatch, skills pack vendor |
| `@agency/tui` | Presentation | Ink/React terminal UI (42 components, 13 overlays) |
| `@agency/core` | Orchestration | Central hub: routing, chat, approval, tasks, agents, workflows, output engine (82 modules) |
| `@agency/contracts` | Contracts | Shared TypeScript type definitions |
| `@agency/providers` | Providers | LLM adapters (6 providers + rate limiter + token optimizer) |
| `@agency/tooling` | Tooling | JSON repair (5-pass), schema coercion, tool registry, MCP supervisor |
| `@agency/workspace` | Infrastructure | File locking + virtual staging + recovery |
| `@agency/context` | Infrastructure | Context degradation (function body stripping) |
| `@agency/memory` | Infrastructure | SQLite: episodic + vector (cosine similarity) + graph (BFS) + FTS5 + CRDT |
| `@agency/governance` | Cross-cutting | Cost budget + provider failover |
| `@agency/heuristics` | Cross-cutting | Loop detection (3 categories) + goal anchoring + risk refinement |
| `@agency/security` | Cross-cutting | 5-level escalation + Docker/Native sandbox + egress proxy + process jail |
| `@agency/skills-bridge` | Integration | Python CodexAI skills pack bridge (28 skills execed read-only) |
| `@agency/benchmark` | Integration | Isolated benchmark runner + regression trace replayer |
| `@agency/browser` | Integration | Playwright/CDP/Mock browser automation |
| `@agency/telemetry` | Cross-cutting | Execution tracing + deterministic replay |

## Architecture Highlights

- **Layered monorepo**: 4 architectural layers (entry, presentation, orchestration, tools/infrastructure)
- **Clean dependency graph**: Bottom-tier packages have zero inter-package dependencies
- **Python bridge**: CodexAI skills pack scripts run via `execa` as read-only tools
- **Multi-layer approval**: Same gating function protects shell, skills, files, and workflows
- **Transactional files**: Lock → stage → verify (`pnpm build`) → commit or rollback
- **Checkpoint-driven tasks**: Crash recovery via persisted task state
- **DAG planner**: Dependency resolution, retries, deadlock detection, cascade rollback
- **Cognition streaming**: Real-time thought events via pub/sub EventBus
- **6 LLM providers**: OpenAI, Anthropic, Google, OpenRouter, NVIDIA, local (Ollama)
- **Deterministic replay**: Full session recording + replay for regression detection
- **Defense-in-depth**: 3-layer security (approval → escalation → sandbox)
- **127 test files, ~1,876 tests**: Vitest across 15 packages
