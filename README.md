<p align="center">
  <strong>⚡ Agency CLI</strong>
</p>

<p align="center">
  Terminal-native CLI + interactive TUI for local AI agent orchestration.<br/>
  Powered by CodexAI Skills pack.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="node" />
  <img src="https://img.shields.io/badge/pnpm-9.x-orange" alt="pnpm" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/packages-16-blueviolet" alt="packages" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="platform" />
</p>

---

[img-hero-screenshot]

<!-- Replace [img-hero-screenshot] with a screenshot of the TUI running in your terminal -->

---

## Table of Contents

- [What Is Agency CLI](#what-is-agency-cli)
- [System Requirements](#system-requirements)
- [Installation](#installation)
- [Two Interfaces: TUI and CLI](#two-interfaces-tui-and-cli)
- [TUI Reference (`acg`)](#tui-reference-acg)
  - [Launching the TUI](#launching-the-tui)
  - [TUI Screens](#tui-screens)
  - [Slash Commands](#slash-commands)
  - [Inline Features](#inline-features)
  - [Themes](#themes)
  - [Environment Flags](#environment-flags)
- [CLI Reference (`agency`)](#cli-reference-agency)
  - [`agency setup`](#agency-setup)
  - [`agency index`](#agency-index)
  - [`agency doctor`](#agency-doctor)
  - [`agency config`](#agency-config)
  - [`agency chat`](#agency-chat)
  - [`agency route`](#agency-route)
  - [`agency routing`](#agency-routing)
  - [`agency workflow`](#agency-workflow)
  - [`agency schedule`](#agency-schedule)
  - [`agency task`](#agency-task)
  - [`agency agents`](#agency-agents)
  - [`agency run`](#agency-run)
  - [`agency skill`](#agency-skill)
  - [`agency plugin`](#agency-plugin)
  - [`agency memory`](#agency-memory)
  - [`agency compact`](#agency-compact)
  - [`agency graph`](#agency-graph)
  - [`agency git`](#agency-git)
  - [`agency browser`](#agency-browser)
  - [`agency team`](#agency-team)
  - [`agency benchmark`](#agency-benchmark)
  - [`agency status`](#agency-status)
  - [`agency eval`](#agency-eval)
  - [`agency replay`](#agency-replay)
  - [`agency replay-regression`](#agency-replay-regression)
  - [`agency handover`](#agency-handover)
- [LLM Provider Configuration](#llm-provider-configuration)
- [Token Budget Policy](#token-budget-policy)
- [Output Surfaces](#output-surfaces)
- [Security & Sandboxing](#security--sandboxing)
- [Multi-Agent Orchestration](#multi-agent-orchestration)
- [Project Architecture](#project-architecture)
  - [Monorepo Packages](#monorepo-packages)
  - [Directory Layout](#directory-layout)
  - [Local State Files](#local-state-files)
- [Scripts](#scripts)
- [Publishing](#publishing)
- [Extended Documentation](#extended-documentation)
- [License](#license)

---

## What Is Agency CLI

Agency CLI is a local-first development tool that connects your code workspace to AI agents. It does three things:

1. **Routes** natural-language prompts to the correct CodexAI skill using a keyword router with self-learning weights.
2. **Executes** multi-step workflows, task plans, and agent dispatches against your project files.
3. **Provides** an interactive terminal interface (TUI) with chat, file context injection, themes, sessions, and live LLM streaming.

The CLI binary is `agency`. The TUI binary is `acg`. Both point to the same entrypoint. When `agency` is called with no subcommand (or when `acg` is called), it launches the interactive TUI. When `agency` is called with a subcommand (e.g. `agency chat`, `agency route`), it runs headless.

---

## System Requirements

| Requirement | Minimum | Recommended |
|:---|:---|:---|
| Node.js | `v22.x` | `v22.x` (LTS) |
| PNPM | `v9.x` | Latest `v9.x` |
| Python | `3.x` | `3.11+` |
| Shell | PowerShell 5.1 (Windows) | PowerShell 7+ / Bash / Zsh |
| Docker | Optional | For sandboxed `agency run` |
| GitHub CLI (`gh`) | Optional | For `agency git pr` |

---

## Installation

### Option A: Automated Setup (Recommended)

```powershell
.\scripts\install.ps1
```

This script performs the following steps in order:

1. Checks that `pnpm` is installed and `PNPM_HOME` is on `PATH`.
2. Runs `pnpm install` to resolve all workspace dependencies.
3. Runs `pnpm build` to compile all 16 TypeScript packages.
4. Links `@agency/cli` globally so `agency` and `acg` are available system-wide.
5. Adds the PNPM global bin directory to the user `PATH` if not already present.
6. Auto-detects `AGENCY_SKILLS_ROOT` (looks for `~/.cursor/skills-cursor`, falls back to repo mock-skills).
7. Installs Playwright Chromium binaries for browser automation capability.
8. Runs `agency setup --project-root .` to generate the workspace index and knowledge graph.

After install, open a **new terminal** (so the updated PATH takes effect) and run:

```powershell
acg
```

### Option B: Manual Setup

```bash
pnpm install
pnpm build
cd packages/cli && pnpm install -g .
agency setup --project-root .
acg
```

### Verify Installation

```powershell
pnpm smoke     # Runs the full 9-step verification pipeline
```

The smoke script runs: build, test, setup, doctor, config, index, route, workflow, agents list, security tests, and a dry-run publish.

---

## Two Interfaces: TUI and CLI

Agency CLI has two modes of operation from the **same binary**:

| Mode | Binary | When | Use Case |
|:---|:---|:---|:---|
| **Interactive TUI** | `acg` or `agency` (no args) | Daily development | Chat with AI, browse sessions, view graph, use slash commands |
| **Headless CLI** | `agency <subcommand>` | Automation / CI / scripting | Route prompts, run workflows, dispatch agents, manage config |

The routing logic is in `tui-launch.ts`. When the first argument is a known subcommand (like `chat`, `route`, `doctor`), it routes to Commander. Otherwise, it launches the React Ink TUI.

```powershell
# These launch TUI:
acg
agency
acg D:\my-project
agency --project-root D:\my-project

# These run headless:
agency doctor
agency chat "fix the flaky test"
agency workflow run create --yes
```

---

## TUI Reference (`acg`)

### Launching the TUI

```powershell
acg                              # TUI in current directory
acg D:\your\project              # TUI targeting a specific project
agency                           # Same as acg (no subcommand = TUI)
agency --project-root D:\path    # Same as acg D:\path
```

[img-tui-splash]

<!-- Replace [img-tui-splash] with a screenshot of the TUI welcome/splash screen -->

### TUI Layout & Overlay Panels

The TUI is designed as a **unified conversational workspace** that runs in an alternate terminal screen buffer. Instead of full-screen tab switching, all utilities and settings are presented as interactive **overlay panels** that slide in or overlay the main chat. This maintains complete visibility of the chat context while you configure your system.

| Trigger / Command | Overlay Panel | Description |
|:---|:---|:---|
| `?` or `Ctrl+H` | **Help & Shortcuts** | View all keyboard navigation keys and slash command aliases |
| `/sessions` | **Sessions Manager** | Browse, search, restore, or delete previous conversation histories |
| `/connect` | **Connections Manager** | Dynamically configure LLM providers and save your API keys securely |
| `/models` | **Model Selector** | Switch between configured models and active AI providers on the fly |
| `/skills` | **Skills Picker** | Browse local CodexAI skills, inspect actions, and inject them into chat context |
| `/mcp` | **MCP Console** | View active MCP server statuses, tool registrations, and environment variables |
| `Ctrl+X` | **Subagent Inspector** | Focus on running subagent instances to inspect their progress details |

[img-tui-chat]

<!-- Replace [img-tui-chat] with a screenshot of the Chat screen in action -->

### Slash Commands

Type these in the prompt bar. All commands start with `/`.

| Command | Alias | What It Does |
|:---|:---|:---|
| `/help` | `/h` | Opens the help overlay with all available commands |
| `/new` | `/clear` | Starts a fresh session, clears route cache |
| `/sessions` | `/session`, `/resume`, `/continue` | Opens the session picker to load a previous chat |
| `/themes` | | Lists available themes and the active one |
| `/theme <name>` | | Switches theme (e.g. `/theme daylight`) |
| `/index` | | Rebuilds `.agency/index.json` for `@` autocomplete |
| `/export` | `/x` | Exports the current session to `.agency/sessions/export-*.md` |
| `/compact` | | Archives old session context (add `dry` for preview) |
| `/connect` | | Opens provider connection overlay |
| `/models` | `/model` | Opens model selector overlay |
| `/model info` | `/model spec` | Prints current model specs (context window, max output, thinking type) |
| `/model probe` | | Live-probes the current model and auto-saves overrides to config |
| `/skills` | `/skill` | Opens skill picker overlay |
| `/plugins` | `/plugin` | Opens plugin manager overlay |
| `/review` | | Opens code review sub-menu |
| `/review commit` | | AI reviews the last git commit |
| `/review branch` | | AI reviews the current branch vs main |
| `/review pr` | | AI reviews as a pull request |
| `/status` | `/viewstatus` | Opens the system status dashboard |
| `/mcp` | | Opens MCP server management |
| `/route feedback <intent>` | | Records a routing correction for the last prompt |
| `/goal <description>` | | Launches a long-running autonomous goal task |
| `/schedule <interval> <task>` | | Adds a recurring schedule (e.g. `/schedule every 30m run tests`) |
| `/agents` | | Opens the sub-agent management panel |
| `/variant` | | Opens thinking/reasoning level selector (for supported models) |
| `/variant <level>` | | Sets thinking budget directly (e.g. `/variant high`, `/variant 8000`) |
| `/project` | | Opens the project picker overlay |
| `/dashboard` | `/memory` | Generates and opens the HTML knowledge dashboard in your browser |
| `/exit` | `/quit`, `/q` | Exits the TUI and restores your terminal |

### Inline Features

**`@` File References**: Type `@` in the prompt to trigger fuzzy file search. Selected files are injected into the conversation context.

```
@packages/core/src/index.ts explain how routing works
```

**`!` Shell Commands**: Prefix with `!` to execute shell commands inline. Output is captured and displayed in the chat.

```
!git status
!pnpm test
```

[img-tui-at-picker]

<!-- Replace [img-tui-at-picker] with a screenshot showing @ file autocomplete -->

### Themes

Two built-in themes are available:

| Theme | Style | Background |
|:---|:---|:---|
| `agency` (default) | Dark mocha with lavender accents | `#1e1e2e` |
| `daylight` | Solarized light with violet accents | `#fdf6e3` |

Persistent theme preference is stored in `~/.agency/tui.json`:

```json
{ "theme": "agency" }
```

[img-tui-theme-agency]
[img-tui-theme-daylight]

<!-- Replace with screenshots of both themes side by side -->

### Environment Flags

| Variable | Default | Effect |
|:---|:---|:---|
| `AGENCY_TUI_SKIP_SPLASH` | `0` | Set to `1` to skip the boot splash animation |
| `AGENCY_TUI_ANIMATIONS` | `1` | Set to `0` to disable shimmer, spinner, and typewriter effects |
| `AGENCY_TUI_SOUND` | `0` | Set to `1` to enable terminal bell on approve/deny actions |
| `AGENCY_SKILLS_ROOT` | auto-detected | Path to the CodexAI skills pack directory |

---

## CLI Reference (`agency`)

Every headless command supports `--project-root <path>` to target a specific workspace. If omitted, the CLI uses the current working directory.

---

### `agency setup`

One-shot bootstrap: indexes workspace files, builds the knowledge graph, creates `~/.agency/config.json` if missing, and checks for LLM API keys.

```powershell
agency setup --project-root .
agency setup --force-index          # Rebuild index from scratch
agency setup --json --quiet         # Machine-readable, suppress stderr meta
```

---

### `agency index`

Builds or incrementally updates the file index at `.agency/index.json`. Also regenerates the knowledge graph.

```powershell
agency index --project-root .
agency index --force                # Full rebuild, ignore cached hashes
```

---

### `agency doctor`

Runs `pack_health` from the skills pack to verify that the CLI, skills, and Python bridge are correctly configured.

```powershell
agency doctor
```

---

### `agency config`

Manages the global LLM provider configuration at `~/.agency/config.json`.

```powershell
agency config init              # Create config template (no overwrite)
agency config init --force      # Overwrite existing config
agency config path              # Print the config file location
```

---

### `agency chat`

Hybrid command: routes the prompt via CodexAI, then queries the configured LLM provider for a response. Outputs human-readable text by default.

```powershell
agency chat "fix flaky auth test"
agency chat "plan MVP" --project-root .
agency chat "refactor module" --provider openrouter
agency chat "debug auth" --budget tight
agency chat "explain this code" --stream             # Live token streaming
agency chat --no-llm "what workflow fits?"           # Route-only, no LLM call
agency chat "complex task" --max-loops 5             # Limit tool-call loops
agency chat "test report" --json --quiet             # JSON stdout, no stderr meta
```

| Option | Description |
|:---|:---|
| `--provider <id>` | Override default provider (`openai`, `anthropic`, `google`, `openrouter`, `nvidia`, `local`) |
| `--no-llm` | Skip LLM call; output route result + suggested commands only |
| `--budget <mode>` | Token budget: `tight`, `normal` (default), `deep` |
| `--stream` | Stream tokens to stdout as they arrive |
| `--json` | Machine-readable JSON output |
| `--quiet` | Suppress routing metadata on stderr |
| `--max-loops <n>` | Maximum tool-call execution loops |

---

### `agency route`

Route a prompt through the CodexAI skills pack without calling any LLM. Shows matched intent, suggested workflow, and next-step commands.

```powershell
agency route "fix flaky test" --project-root .
agency route "debug flaky login test" --json
```

---

### `agency routing`

Manage self-learning routing weights. Weights are stored in `.agency/routing-weights.json` and automatically applied by `agency route` and `agency chat`.

```powershell
agency routing weights --project-root .                         # Show current weights
agency routing feedback --prompt "fix auth bug" --intent debug  # Record a correction
```

When you record feedback, the prompt's keywords are tokenized and associated with the correct intent. Future prompts containing similar keywords will be biased toward that intent.

---

### `agency workflow`

Compose and run multi-step CodexAI script chains.

```powershell
agency workflow list                                              # List all workflows and their steps
agency workflow list --json                                       # Machine-readable
agency workflow run create --project-root . --yes                 # Run the "create" workflow
agency workflow run plan --prompt "plan auth refactor" --yes      # Run "plan" with a prompt
agency workflow run create --preflight --yes                      # Include slow runtime_hook preflight (~5min)
```

| Option | Description |
|:---|:---|
| `--prompt <text>` | Injected prompt for the planner step |
| `--preflight` | Run `runtime_hook` preflight (slow, ~5min on large repos) |
| `--yes` | Auto-approve steps that write artifacts |

---

### `agency schedule`

Cron-like local workflow scheduler. Schedules are stored in `.agency/schedules.json`. There is no background daemon; run `agency schedule run` manually or from an external cron.

```powershell
agency schedule list                                                    # List all schedules
agency schedule add --workflow create --every 5m                        # Every 5 minutes
agency schedule add --workflow plan --cron "0 9 * * *" --require-approval  # Daily at 9am, needs --yes
agency schedule remove sched-abc123                                     # Remove by ID
agency schedule run                                                     # Execute all due schedules
agency schedule run --yes                                               # Execute and auto-approve
```

Interval formats: `--every 5m`, `--every 1h`, `--cron daily:09:00`, `--cron every:5m`, or standard 5-field cron (`*/5 * * * *`).

---

### `agency task`

Long-running plan runner with checkpoint save/resume. Parses a Markdown plan file, dispatches each task to the matched agent, and runs `auto_gate` validation periodically.

```powershell
agency task start plan.md --project-root .                    # Start from task 1
agency task start plan.md --from 3                            # Start from task 3
agency task start plan.md --gate-every 5                      # Gate every 5 tasks (0 = off)
agency task start plan.md --harness --max-attempts 3          # Self-correction loop
agency task resume <checkpoint-id>                            # Resume from last checkpoint
agency task list --project-root .                             # List all saved checkpoints
agency task abort <checkpoint-id>                             # Abort a running task
```

---

### `agency agents`

Multi-agent orchestrator. Each dispatch spawns a subprocess with isolated environment (only `PATH` + `AGENCY_*` vars). Logs saved to `.agency/agents/dispatch-<timestamp>.json`.

```powershell
agency agents list                                                          # List available agent roles
agency agents dispatch planner --task "Break down T22 into subtasks"        # Single dispatch
agency agents dispatch debugger --task "Investigate test" --project-root .  # With project root
agency agents dispatch planner --task "Draft plan" --max-loops 20           # Limit loops

# Parallel dispatch: multiple agents run concurrently with workspace isolation
agency agents parallel --dispatches '[{"agentId":"planner","task":"Plan"},{"agentId":"debugger","task":"Debug"}]'
agency agents parallel --dispatches-file dispatches.json --project-root .
```

Parallel dispatch clones the workspace into temporary directories, runs agents concurrently, then merges results. If merge conflicts occur (same lines edited by different agents), the operation is aborted and conflicting files are reported.

---

### `agency run`

Execute a shell command with optional sandboxing. Prompts for confirmation when the command matches destructive patterns (e.g. `rm -rf`, `del`, `format`).

```powershell
agency run "pnpm test" --project-root .                        # Native execution (default)
agency run "npm install" --sandbox-mode docker                  # Docker sandbox
agency run "rm -rf dist" --yes                                 # Skip approval prompt
agency run "build.sh" --docker-image node:22-alpine             # Custom image
agency run "test.sh" --docker-network-disabled                  # No network access
agency run "heavy-task" --docker-memory 512m --docker-cpu 0.5   # Resource limits
```

---

### `agency skill`

Inspect and invoke individual CodexAI skills from the skills pack.

```powershell
agency skill list                       # List all skills with their aliases
agency skill show plan-writer           # Show skill metadata, description, TL;DR
agency skill show $plan                 # Same, using alias syntax
agency skill invoke $plan               # Resolve alias to path and harness mode hint
```

---

### `agency plugin`

Plugin SDK tools for exporting and validating the `plugin-tools.json` contract.

```powershell
agency plugin validate                  # Run validation script against skills pack
agency plugin tools                     # Print plugin-tools.json to stdout
agency plugin tools -o tools.json       # Write to file
agency plugin schema                    # Print path to plugin-tools.schema.json
```

Set `AGENCY_SKILLS_ROOT` to point at your skills pack directory.

---

### `agency memory`

Project memory bridge. Connects to `build_knowledge_graph.py` and other memory scripts.

```powershell
agency memory status --project-root .    # Check knowledge artifacts for staleness
agency memory build --project-root . --yes  # Build/rebuild knowledge index (mutating, needs --yes)
agency memory genome --project-root .    # Generate layered project context documentation
agency memory genome --depth auto        # Auto-detect scan depth
```

---

### `agency compact`

Archive old `.agency` or `.codex` session and feedback files to free workspace memory.

```powershell
agency compact --dry-run                                      # Preview savings without changes
agency compact --yes                                          # Apply compaction (mutating)
agency compact --dry-run --max-age-days 60 --keep-latest 3    # Custom thresholds
```

Mutating compaction requires `--yes` (same approval policy as `agency memory build`).

---

### `agency graph`

Render the workspace knowledge graph summary to the console.

```powershell
agency graph --project-root .
```

The graph data comes from `.agency/knowledge/knowledge-graph.json`, which is built by `agency index`, `agency setup`, or `agency memory build`.

---

### `agency git`

Git repository intelligence.

```powershell
agency git summary                      # Branch, working tree status, recent commits (JSON)
agency git summary --project-root .
agency git pr                           # GitHub PR status (requires gh CLI)
agency git pr --create                  # Print "gh pr create" guidance
```

---

### `agency browser`

Browser automation bridge via Cursor IDE Browser MCP.

```powershell
agency browser status                   # Check browser MCP configuration (JSON)
agency browser open <url>               # Open URL (requires MCP, prints hint if missing)
agency browser open <url> --system      # Fallback: open in OS default browser
```

---

### `agency team`

Local team governance. Stores profiles in `.agency/team.json`.

```powershell
agency team init --name "My Team"                             # Initialize team config
agency team show                                              # Display team JSON
agency team member add --id u1 --name "Alice" --role dev      # Add member
agency team member add --id u2 --name "Bob" --role qa --email bob@example.com
```

Supported roles: `lead`, `dev`, `qa`, `devops`. When `requireApprovalForDeploy: true` is set in team config, destructive commands require team member approval.

---

### `agency benchmark`

Run isolated evaluation benchmarks to measure routing accuracy and execution cost.

```powershell
agency benchmark --list                 # List all available benchmark tasks
agency benchmark --list --json          # Machine-readable
agency benchmark                        # Run all benchmarks
agency benchmark task-001               # Run a specific benchmark
agency benchmark --budget 10.0          # Set max spend cap in USD (default: 5.0)
agency benchmark --json                 # JSON output
```

---

### `agency status`

Inspect runtime state: resolved feature flags, recent events, task checkpoints, and any resumable work. Read-only.

```powershell
agency status                           # Human-readable runtime snapshot
agency status --json                    # Machine-readable
```

---

### `agency eval`

Run the task-eval suite and gate the task success rate against a saved baseline. Offline by default; `--agent` attaches the real agent runtime (needs provider keys).

```powershell
agency eval                             # Offline corpus, gate vs baseline
agency eval --agent --suite hard        # Real agent on the hard corpus
agency eval --update-baseline           # Save current report as the new baseline
```

| Option | Description |
|:---|:---|
| `--agent` | Attach the real agent runtime (needs provider keys) |
| `--suite <name>` | Corpus: `easy` (default), `hard`, `all` |
| `--baseline <path>` | Baseline report (default `.agency/eval-baseline.json`) |
| `--update-baseline` | Write current report as baseline (no gating) |
| `--tolerance <frac>` | Allowed success-rate drop, `0..1` (default `0`) |
| `--budget <amount>` | Max spend per task in USD (default `5.0`) |
| `--provider <id>` | Provider for `--agent` runs |

---

### `agency replay`

Replay the recorded durable event journal (`.agency/events/journal.db`) and verify it has not diverged or been corrupted — each event's payload must still hash to its stored `payloadHash`. Exits non-zero on divergence.

```powershell
agency replay
agency replay --json
```

---

### `agency replay-regression`

Drive the behaviour-trace regression engine over a recorded trace from `.agency/traces/` (produced when `AGENCY_TRACE_RECORD` is set). Validates a trace is replay-ready, or — with `--baseline` — checks a candidate trace reproduces the baseline's tool behaviour.

```powershell
agency replay-regression --list                         # List recorded traces
agency replay-regression <trace>                         # Validate a trace is replay-ready
agency replay-regression <candidate> --baseline <ref>    # Regression: candidate vs baseline
```

---

### `agency handover`

Generate `.agency/handover.md` so a new session can resume with minimal context loss (current branch, recent work, open tasks).

```powershell
agency handover                         # Write .agency/handover.md
agency handover --print                 # Also print to stdout
```

---

## LLM Provider Configuration

All provider settings live in `~/.agency/config.json`. Keys support `${ENV_VAR}` expansion at runtime.

```powershell
agency config init      # Create template
agency config path      # Show file location
```

Example `~/.agency/config.json`:

```json
{
  "defaultProvider": "openrouter",
  "providers": {
    "openrouter": {
      "apiKey": "${OPENROUTER_API_KEY}",
      "model": "anthropic/claude-sonnet-4"
    },
    "nvidia": {
      "apiKey": "${NVIDIA_API_KEY}",
      "model": "meta/llama-3.1-70b-instruct"
    },
    "google": {
      "apiKey": "${GOOGLE_API_KEY}",
      "model": "gemini-2.5-pro"
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "model": "gpt-4o"
    },
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-sonnet-4-20250514"
    },
    "local": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "llama3"
    }
  }
}
```

Supported providers: `openrouter`, `nvidia`, `google`, `openai`, `anthropic`, `local` (Ollama).

Without an API key, `agency chat` falls back to route-only output (same as `--no-llm`): it prints the matched route, suggested commands, and workflow hints.

---

## Token Budget Policy

The `--budget` flag controls how aggressively the engine loads context and limits LLM output:

| Budget | Context Files | Max Output Tokens | Route Cache |
|:---|:---|:---|:---|
| `tight` | 0 | 512 | Yes |
| `normal` (default) | up to 3 | 1024 | Yes |
| `deep` | up to 6 | 2048 | No |

- `agency chat` never runs `runtime_hook` by default (use `agency workflow run --preflight` for that).
- Route results are cached per session to avoid redundant `prompt_router` calls for identical prompts.

---

## Output Surfaces

Every CLI command that produces output respects a consistent surface model:

| Surface | Where | Controlled By |
|:---|:---|:---|
| **Human** (default) | stdout | Default for `acg`, `agency chat` |
| **JSON** | stdout | `--json` flag |
| **Meta** | stderr | Routing diagnostics, timing; hide with `--quiet` |
| **Stream** | stdout | `--stream` flag on `agency chat`; live SSE tokens in TUI |

---

## Security & Sandboxing

`agency run` supports two execution modes:

### Native Mode (default)

Commands run directly on the host. If the command matches destructive patterns (e.g. `rm -rf`, `format`, `del`), the CLI prompts for confirmation unless `--yes` is passed.

### Docker Mode

Commands run inside isolated Docker containers:

```powershell
agency run "npm test" --sandbox-mode docker
agency run "build.sh" --docker-image node:22-alpine
agency run "risky-cmd" --docker-network-disabled --docker-memory 512m --docker-cpu 0.5
```

| Option | Description |
|:---|:---|
| `--docker-image` | Container image (default: `node:22-alpine`) |
| `--docker-network-disabled` | Block all outbound network access |
| `--docker-memory` | Memory limit (e.g. `512m`, `1g`) |
| `--docker-cpu` | CPU limit (e.g. `0.5` = half a core) |

The project root is mounted as a read-write volume inside the container. Nothing outside the project directory is accessible.

The `@agency/security` package also provides process-level egress proxying and FFI-based jailing via `koffi`.

---

## Multi-Agent Orchestration

The `agency agents parallel` command implements concurrent workspace-isolated agent execution:

1. The workspace is cloned into N temporary directories (one per agent).
2. Each agent runs in a subprocess with a stripped environment (only `PATH` + `AGENCY_AGENT_ID`, `AGENCY_TASK`, `AGENCY_PROJECT_ROOT`).
3. After completion, a merge engine diffs each clone against the original, applies changes, and detects conflicts.
4. If two agents modified the same file region, the merge aborts and reports conflicting paths.

```powershell
agency agents parallel --dispatches '[
  {"agentId": "planner", "task": "Draft implementation plan"},
  {"agentId": "debugger", "task": "Fix failing test in auth module"}
]'
```

[img-multi-agent-flow]

<!-- Replace [img-multi-agent-flow] with a diagram showing parallel agent dispatch and merge -->

---

## Project Architecture

### Monorepo Packages

16 packages under `packages/`, managed by PNPM workspaces:

| Package | Description |
|:---|:---|
| `@agency/cli` | Commander-based CLI entry point. Registers all subcommands. Houses `agency` and `acg` bin entries. |
| `@agency/tui` | React Ink alternate-screen terminal UI. Handles rendering, input focus, slash commands, and sessions. |
| `@agency/core` | Central engine: prompt routing, workflow execution, knowledge graph builder, task checkpoints, approvals, scheduling, team config, Git summary, shell execution. |
| `@agency/providers` | LLM adapters for OpenAI, Anthropic, Google, NVIDIA, OpenRouter, and Ollama (local). Handles streaming, rate limiting, token optimization, thinking specs, and model probing. |
| `@agency/skills-bridge` | Loads `plugin-tools.json`, resolves skill aliases, parses skill Markdown files, and runs Python scripts via `execa`. |
| `@agency/security` | Process jail, Docker sandbox runner, egress proxy, and capability validation. Uses `koffi` for FFI. |
| `@agency/memory` | SQLite-backed episodic memory and vector index semantic memory. Uses `better-sqlite3` and `lru-cache`. |
| `@agency/workspace` | Workspace file locking, virtual transaction staging, and recovery engine. |
| `@agency/governance` | Token cost governance, provider budget supervision. |
| `@agency/heuristics` | Loop detection, goal anchoring, and command safety heuristics. |
| `@agency/telemetry` | Execution profiling, tracing, and deterministic replay engine. |
| `@agency/benchmark` | Evaluation fixtures for routing accuracy and agent cost measurement. |
| `@agency/tooling` | Self-healing JSON parser, schema coercion, MCP tool registry supervisor. |
| `@agency/contracts` | Shared TypeScript interfaces and JSON schema declarations. |
| `@agency/context` | Environment variable loaders and path resolution. |
| `@agency/browser` | Cursor IDE browser automation plugin drivers. |

### Directory Layout

```
agency-cli/
  packages/
    cli/                 # @agency/cli       - Commander entry, bin: agency + acg
    tui/                 # @agency/tui       - React Ink terminal interface
    core/                # @agency/core      - Routing, workflows, graph, tasks
      src/
        agents/          # Agent dispatcher + parallel orchestrator
        approval/        # Approval engine (destructive command gating)
        browser/         # Browser MCP status checker
        chat/            # Chat turn runner, prompt builder, circuit breaker
        context/         # Context file assembly
        events/          # Event bus + durable journal + replay engine
        git/             # Git summary, PR helper
        graph/           # Knowledge graph builder (generates HTML dashboard)
        index/           # Workspace file indexer
        kernel/          # Execution kernel
        memory/          # Memory script bridge
        mcp/             # MCP client connector
        output/          # OutputEngine (human/JSON/meta/stream)
        router/          # Prompt router with weights
        runtime/         # Feature flags + session handover digest
        scheduler/       # Cron schedule runner
        skill/           # Skill registry, tool harness, context delivery
        task/            # Task checkpoint runner, convergence engine
        team/            # Team config loader
        terminal/        # Terminal helpers
        utils/           # Package manager detection, misc
        workflow/        # Workflow definition + runner
    providers/           # @agency/providers  - LLM adapters
    skills-bridge/       # @agency/skills-bridge - Plugin tools execution
    security/            # @agency/security   - Sandboxing + egress proxy
    memory/              # @agency/memory     - SQLite episodic/vector memory
    workspace/           # @agency/workspace  - File lock + staging
    governance/          # @agency/governance - Cost governance
    heuristics/          # @agency/heuristics - Loop detection
    telemetry/           # @agency/telemetry  - Tracing + profiling
    benchmark/           # @agency/benchmark  - Evaluation harness
    tooling/             # @agency/tooling    - Schema coercion + MCP
    contracts/           # @agency/contracts  - Shared types
    context/             # @agency/context    - Env resolution
    browser/             # @agency/browser    - Browser drivers
  scripts/
    install.ps1          # Automated setup + global link
    smoke.ps1            # 9-step verification pipeline
    publish.ps1          # Publish to npm with Git tag automation
    pack-local.ps1       # Build local tarballs
    dogfood.ps1          # Dogfooding integration checks
    version-bump.ps1     # Version bump utility
  tests/
    fixtures/            # Mock skills and test data
  docs/                  # Extended technical documentation (12 guides)
```

### Local State Files

Agency CLI generates these files in your workspace:

| Path | Created By | Purpose |
|:---|:---|:---|
| `.agency/index.json` | `agency setup`, `agency index` | Workspace file index for `@` autocomplete in TUI |
| `.agency/knowledge/knowledge-graph.json` | `agency index`, `agency setup` | Structural graph of files, directories, and skill associations |
| `.agency/knowledge/index.html` | `agency index`, `agency setup` | Interactive HTML dashboard (opened by `/dashboard`) |
| `.agency/routing-weights.json` | `agency routing feedback` | Self-learning weights that bias prompt routing |
| `.agency/schedules.json` | `agency schedule add` | Cron schedule definitions |
| `.agency/team.json` | `agency team init` | Team member roles and approval policies |
| `.agency/sessions/` | TUI sessions | Persisted conversation logs (Markdown + JSON) |
| `.agency/agents/` | `agency agents dispatch` | Dispatch execution logs (`dispatch-<ts>.json`) |
| `~/.agency/config.json` | `agency config init`, `agency setup` | Global LLM provider configuration |
| `~/.agency/tui.json` | TUI `/theme` command | Global TUI theme preference |

---

## Scripts

| Script | Command | Description |
|:---|:---|:---|
| `install.ps1` | `.\scripts\install.ps1` | Full setup: install, build, link, detect skills, install browser |
| `smoke.ps1` | `pnpm smoke` | 9-step verification: build, test, setup, doctor, config, route, workflow, security, publish dry-run |
| `publish.ps1` | `pnpm publish:dry` / `pnpm publish:release` | Publish pipeline: dirty check, branch check, test, build, publish in dependency order, Git tag + push |
| `pack-local.ps1` | `pnpm pack:local` | Build tarballs to `dist-packs/` |
| `dogfood.ps1` | `pnpm dogfood` | Automated + manual dogfooding checks |
| `version-bump.ps1` | Direct | Bump version across all workspace packages |

---

## Publishing

The publish pipeline (`scripts/publish.ps1`) enforces strict pre-release gates:

1. **Dirty check**: If the Git working directory is dirty and `-Publish` is active, the script throws. In dry-run mode, it warns.
2. **Branch check**: Warns if not on `main` or `master`.
3. **Version**: Reads version from `packages/cli/package.json`.
4. **Tests**: Runs `pnpm -r test` (skip with `-SkipTest`).
5. **Build**: Runs `pnpm -r build`.
6. **Publish**: Publishes packages in dependency order: `providers` -> `core` -> `skills-bridge` -> `tui` -> `cli`.
7. **Git tag**: Creates and pushes `v<version>` tag to origin (only in `-Publish` mode).

```powershell
pnpm publish:dry              # Dry-run all packages
pnpm publish:release          # Publish + tag + push
```

See [PUBLISH.md](PUBLISH.md) for detailed publishing workflow.

---

## Extended Documentation

The `docs/` directory contains 12 in-depth technical guides:

| Document | Topic |
|:---|:---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture overview |
| [CORE_ENGINE.md](docs/CORE_ENGINE.md) | Core engine internals: routing, workflows, approvals |
| [CLI_REFERENCE.md](docs/CLI_REFERENCE.md) | Complete CLI command reference |
| [PACKAGES.md](docs/PACKAGES.md) | Detailed package-by-package documentation |
| [CONFIG_AND_STATE.md](docs/CONFIG_AND_STATE.md) | Configuration files and state management |
| [SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Security model: sandboxing, egress, approvals |
| [UI_DESIGN.md](docs/UI_DESIGN.md) | TUI design specifications and component library |
| [SKILLS_PACK.md](docs/SKILLS_PACK.md) | CodexAI skills pack integration guide |
| [TESTING.md](docs/TESTING.md) | Testing strategy and guidelines |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Development setup and contribution guide |
| [TELEMETRY_BENCHMARK.md](docs/TELEMETRY_BENCHMARK.md) | Telemetry, profiling, and benchmarks |
| [docs/README.md](docs/README.md) | Documentation index |

---

## License

[MIT](LICENSE) -- Copyright (c) 2026 Agency CLI contributors
