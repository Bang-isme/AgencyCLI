# Agency CLI — Skills Pack System

## Overview

The skills pack is a **Python-based execution kernel** vendored in `packages/cli/skills/`. It contains 28 skill modules, 8 agent definitions, 8 workflow definitions, 14 system scripts, and a self-describing manifest. The CLI bridge (`@agency/skills-bridge`) loads and runs skills via `execa` without ever modifying them — **all interaction is read-only**.

## Skills Pack Location Resolution

`resolveSkillsRoot()` cascade:
```
1. AGENCY_SKILLS_ROOT environment variable
2. Local monorepo development path (`packages/cli/skills`)
3. Bundled `@agency/cli/skills` (shipped inside the package)
4. `~/.agency/skills`
5. `~/.cursor/skills-cursor` (fallback)
6. `~/.codex/skills` (fallback)
7. Bootstrap empty manifest at `~/.agency/skills`
```

Validation: checks that `.system/manifest.json` exists at the resolved path.

---

## Architecture

```
CLI/TUI Layer (TypeScript)
    │
    ▼
@agency/skills-bridge (TypeScript)
    ├── registry.ts         → loadPluginTools() — parse plugin-tools.json
    ├── runner.ts           → runTool(), runBuiltinScript() — execa
    ├── builtins.ts         → BUILTIN_SCRIPTS map
    ├── aliases.ts          → SKILL_ALIASES map
    ├── loader.ts           → loadManifestSkills()
    └── skill-md.ts         → parseSkillMd()
    │
    ▼
execa("python", [script, ...args])
    │
    ▼
Skills Pack (Python)
    ├── .system/manifest.json    — central registry
    ├── .system/scripts/         — 14 orchestration scripts
    ├── .agents/                 — 8 agent role definitions
    ├── .workflows/              — 8 workflow definitions
    └── codex-*/SKILL.md         — 28 skill modules
```

---

## Manifest (`.system/manifest.json`)

The central registry defines:

```json
{
  "version": "15.2.0",
  "skills": [/* 28 entries */],
  "agents": [/* 8 entries */],
  "workflows": [/* 8 entries */],
  "plugin_tools": {/* contract references */},
  "codex_plugin": {/* Codex IDE integration */},
  "claude_plugin": {/* Claude IDE integration */},
  "load_order": {
    "always": ["codex-master-instructions", "codex-intent-context-analyzer",
               "codex-context-engine", "codex-verification-discipline"],
    "on_demand": [/* 24 remaining skills */]
  }
}
```

**4 Always-loaded core skills:** master-instructions, intent-context-analyzer, context-engine, verification-discipline
**24 On-demand skills:** loaded as needed based on prompt routing

---

## 28 Skill Modules

Each skill is a directory containing `SKILL.md` (YAML frontmatter + markdown body) and optional subdirectories for agents, references, scripts, templates.

| # | Skill Directory | Purpose |
|---|----------------|---------|
| 1 | `codex-master-instructions` | Master instruction set *(always loaded)* |
| 2 | `codex-intent-context-analyzer` | Intent/context analysis *(always loaded)* |
| 3 | `codex-context-engine` | Context engine *(always loaded)* |
| 4 | `codex-verification-discipline` | Verification discipline *(always loaded)* |
| 5 | `codex-plan-writer` | Architecture & implementation planning |
| 6 | `codex-workflow-autopilot` | Workflow automation + code explanation |
| 7 | `codex-reasoning-rigor` | Strict reasoning briefs |
| 8 | `codex-document-writer` | Document writing |
| 9 | `codex-role-docs` | Role-scoped project documentation |
| 10 | `codex-spec-driven-development` | Spec-driven development with validation |
| 11 | `codex-design-system` | Design system |
| 12 | `codex-design-md` | DESIGN.md contracts |
| 13 | `codex-domain-specialist` | Domain-specific expertise |
| 14 | `codex-security-specialist` | Security analysis |
| 15 | `codex-execution-quality-gate` | Quality gates — 20 scripts for CI/CD |
| 16 | `codex-project-memory` | Episodic memory, knowledge graphs, context |
| 17 | `codex-docs-change-sync` | Code→docs change mapping |
| 18 | `codex-git-autopilot` | Git automation |
| 19 | `codex-doc-renderer` | DOCX→image rendering |
| 20 | `codex-scrum-subagents` | Scrum sub-agent orchestration |
| 21 | `codex-test-driven-development` | TDD workflow |
| 22 | `codex-systematic-debugging` | Systematic debugging |
| 23 | `codex-subagent-execution` | Sub-agent execution |
| 24 | `codex-git-worktrees` | Git worktree support |
| 25 | `codex-branch-finisher` | Branch finishing |
| 26 | `codex-project-pulse` | Project health monitoring |
| 27 | `codex-runtime-hook` | Runtime hook system |
| 28 | `codex-logical-decision-layer` | Decision matrix |

---

## 8 Agent Definitions (`.agents/`)

| Agent File | Role |
|------------|------|
| `.agents/frontend-specialist.md` | Frontend specialist |
| `.agents/backend-specialist.md` | Backend specialist |
| `.agents/security-auditor.md` | Security auditor |
| `.agents/debugger.md` | Debugger |
| `.agents/test-engineer.md` | Test engineer |
| `.agents/devops-engineer.md` | DevOps engineer |
| `.agents/planner.md` | Planner |
| `.agents/scrum-master.md` | Scrum master |

Agent profiles in `@agency/core/agents/profiles.ts` map each agent to their skill arrays.

---

## 8 Workflow Definitions (`.workflows/`)

| Workflow File | Purpose |
|---------------|---------|
| `plan.md` | Architecture planning workflow |
| `debug.md` | Bug investigation workflow |
| `create.md` | Feature creation workflow |
| `review.md` | Code review workflow |
| `deploy.md` | Deployment workflow |
| `handoff.md` | Project handoff workflow |
| `refactor.md` | Refactoring workflow |
| `prototype.md` | Spec-driven prototyping |

Each workflow chains multiple Python scripts in sequence, with optional approval gates.

---

## 14 System Scripts (`.system/scripts/`)

| Script | Purpose |
|--------|---------|
| `prompt_router.py` | **Core router** — takes a prompt, returns intent/workflow/agent/skills as JSON |
| `auto_gate.py` | Quality gate — validates task completion |
| `runtime_hook.py` | Runtime hook — pre/post task execution |
| `check_pack_health.py` | Pack integrity check (manifest, registry, aliases, sync, mojibake detection) |
| `trust_harness.py` | Generic setup/validation/evidence harness |
| `pre_commit_check.py` | Pre-commit validation |
| `validate_codex_plugin.py` | Codex plugin validation |
| `validate_claude_plugin.py` | Claude plugin validation |
| `validate_tool_contracts.py` | Tool contract validation |
| `install_codex_native.py` | Codex-native installer |
| `install_claude_native.py` | Claude-native installer |
| `init_agents_md.py` | AGENTS.md bridge creator |
| `sync_global_skills.py` | Global skills sync |
| `build_release_zip.py` | Clean release ZIP builder |

---

## Skill Aliases

**Location:** `packages/skills-bridge/src/aliases.ts`

`SKILL_ALIASES` maps ~70 `$`-prefixed shortcuts to skill packs (`resolveSkillAlias()`; `aliasesForSkill()` reverses it). A representative sample:

| Alias | Resolves To |
|-------|------------|
| `$plan` | `codex-plan-writer` |
| `$tdd` / `$red-green` | `codex-test-driven-development` |
| `$gate` / `$check` / `$health` / `$doctor` | `codex-execution-quality-gate` |
| `$sdd` / `$dispatch` | `codex-subagent-execution` |
| `$spec` | `codex-spec-driven-development` |
| `$hook` / `$preflight` | `codex-runtime-hook` |
| `$verify` / `$evidence` | `codex-verification-discipline` |
| `$debug` / `$root-cause` / `$trace` | `codex-systematic-debugging` |
| `$finish` / `$finish-branch` | `codex-branch-finisher` |
| `$create` / `$review` / `$deploy` / `$refactor` / `$handoff` / `$prototype` | `codex-workflow-autopilot` |
| `$git` / `$commit` | `codex-git-autopilot` |
| `$scrum-*` / `$sprint-plan` / `$daily-scrum` | `codex-scrum-subagents` |

Usage in prompt: `$plan Design a user authentication system` — the `$plan` prefix triggers plan-writer mode.

---

## Built-in Scripts

**Location:** `packages/skills-bridge/src/builtins.ts`

`BUILTIN_SCRIPTS` maps 4 logical names to skill-pack script paths:

| Builtin Name | Script Path |
|-------------|-------------|
| `prompt_route` | `.system/scripts/prompt_router.py` |
| `plugin_validate` | `.system/scripts/validate_codex_plugin.py` |
| `runtime_hook` | `codex-runtime-hook/scripts/runtime_hook.py` |
| `auto_gate` | `codex-execution-quality-gate/scripts/auto_gate.py` |

> Other scripts (e.g. `pre_commit_check.py`, `memory_status.py`, `tech_debt_scan.py`, `security_scan.py`) are invoked by **workflow steps** (`workflow/compose.ts`) via their full pack-relative paths, not through `BUILTIN_SCRIPTS`.

---

## Plugin Tools Contract (`plugin-tools.json`)

**Location:** `.system/references/plugin-tools.json`

Each tool is defined as:

```json
{
  "tools": [
    {
      "name": "prompt_route",
      "script": ".system/scripts/prompt_router.py",
      "description": "Route user prompts to workflows and agents",
      "safety_policy": {
        "writes_artifacts": false,
        "network_access": false,
        "requires_approval": false
      }
    }
  ]
}
```

Loaded via `loadPluginTools()` which validates against `plugin-tools.schema.json` using Zod.

---

## Skill.md Format

Each skill's `SKILL.md` uses YAML frontmatter:

```markdown
---
name: Plan Writer
description: Generates structured implementation plans
mode: plan
aliases: [$plan, plan-writer]
---

## TL;DR
Generates step-by-step implementation plans from high-level goals.
```

Parsed by `parseSkillMd()`:
- Extracts YAML frontmatter (name, description, mode, aliases)
- Extracts TL;DR section (everything after `## TL;DR` until next heading)
- `extractTldr()` returns the first sentence of TL;DR

---

## Execution Safety

### Approval Gating

Before execution, `runTool()` checks `safety_policy`:

| Policy | Effect |
|--------|--------|
| `writes_artifacts: true` | Requires user approval |
| `network_access: true` | Requires network security level |
| `requires_approval: true` | Always requires approval |

### Execution via `execa`

```typescript
runTool(toolName: string, args: string[]): Promise<RunResult>
runBuiltinScript(name: string, args: string[]): Promise<RunResult>
```

- Spawns `python <script-path> <args...>`
- 360-second timeout for runtime hooks
- Captures stdout/stderr/exit code
- Fail-closed: non-zero exit → error returned

---

## CLI Commands for Skills

```bash
# List all installed skills
agency skill list

# Show skill details
agency skill show codex-plan-writer
agency skill show $plan           # via alias

# Invoke a skill
agency skill invoke $plan         # prints config hints + next steps
agency skill invoke $tdd          # prints harness mode info

# Plugin tools
agency plugin tools               # export plugin-tools.json
agency plugin tools -o out.json   # write to file
agency plugin validate            # validate tools against schema
agency plugin schema              # print schema path
```

## TUI Integration

- **`/skills`** — opens `SkillsPicker` overlay to browse and inject skills
- **`/plugins`** — opens `PluginsOverlay` to view installed skill packs
- **Agent modes** — Prefix injection (`$plan`, `$debug`, `[READ-ONLY]`) based on Tab-cycled mode
