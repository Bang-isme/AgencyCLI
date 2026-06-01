# Agency CLI — Command Reference

## Binary Entry Points

| Command | Mode | Description |
|---------|------|-------------|
| `agency` | Headless (with subcommand) or TUI (no subcommand) | Main binary |
| `acg` | Always TUI | Alias for interactive terminal mode |

## TUI vs Headless Decision Logic

```
agency                  → TUI (no subcommand)
agency <project-path>   → TUI (single path argument)
agency --project-root <path> → TUI (explicit project flag)
acg [path]              → Always TUI
agency <command> [opts] → Headless (Commander subcommand)
```

---

## Headless Commands (21 subcommands)

### `agency chat <prompt>`
Run a single hybrid route + LLM reply turn (human-readable by default).

```
agency chat "Fix the authentication bug in login.ts"
agency chat "Add unit tests for the UserService" --provider anthropic
agency chat "Explain the routing architecture" --budget deep --stream
```

**Options:**
- `--project-root <path>` — Project root for routing weights
- `--provider <id>` — LLM provider override (anthropic, openai, google, openrouter, nvidia, local)
- `--no-llm` — Force route-only output (skip LLM even if an API key is set)
- `--budget <mode>` — Token budget: `tight` \| `normal` \| `deep` (default: normal)
- `--json` — Machine-readable JSON (includes routing metadata)
- `--stream` — Stream LLM tokens to stdout as they arrive
- `--quiet` — Suppress routing meta on stderr
- `--max-loops <number>` — Maximum execution loops for tool calls

---

### `agency route <prompt>`
Only run prompt routing (no LLM call). Shows intent, workflow, skills, and suggested agent.

```
agency route "refactor the database layer"
agency route "deploy to production" --json
```

**Output:**
```json
{
  "intent": "refactor",
  "workflow": "refactor",
  "skills": ["codex-spec-driven-development", "codex-test-driven-development"],
  "provider": "anthropic",
  "suggestedAgent": "backend-specialist",
  "confidence": 0.85,
  "warnings": []
}
```

**Options:**
- `--project-root <path>` — Explicit project root path
- `--json` — JSON output

---

### `agency run <command>`
Execute a shell command with approval gating and sandboxing.

```
agency run "npm test"
agency run "npm install --save-dev vitest" --yes
agency run "npm test" --sandbox-mode docker --docker-memory 512m --docker-network-disabled --yes
```

**Options:**
- `--project-root <path>` — Project root directory
- `--yes` — Approve commands that match destructive patterns
- `--sandbox-mode <mode>` — Execution sandbox: `native` (default) or `docker`
- `--docker-image <image>` — Docker image (default: `node:22-alpine`)
- `--docker-network-disabled` — Disable network access in the Docker container
- `--docker-memory <limit>` — Container memory limit (e.g. `512m`)
- `--docker-cpu <limit>` — Container CPU limit (e.g. `0.5`)

---

### `agency skill <subcommand>`
List, inspect, and invoke CodexAI skills from the skills pack.

```
agency skill list
agency skill show codex-plan-writer
agency skill invoke $plan
```

**Subcommands:**
- `list` — List skills from the pack manifest
- `show <name-or-alias>` — Show skill metadata and TL;DR (accepts name or alias, e.g. `$plan`)
- `invoke <alias>` — Resolve an alias to its skill path + harness mode hint

---

### `agency task <subcommand>`
Long-running plan runner with checkpoints. Plans use `### Task N:` headers.

```
agency task start plan.md --harness --max-attempts 3
agency task resume <checkpoint-id>
agency task list
agency task abort <checkpoint-id>
```

**Subcommands:**
- `start <plan>` — Start executing tasks from a markdown plan
- `resume <id>` — Resume a plan run from its last checkpoint
- `list` — List saved task checkpoints
- `abort <id>` — Abort a running or paused task run

**Options (`start` / `resume`):**
- `--from <n>` — Start at task number N (`start` only)
- `--gate-every <n>` — Run `auto_gate` every N tasks (0 = off)
- `--harness` — Enable closed-loop verification self-correction harness
- `--max-attempts <n>` — Max attempts for the harness loop
- `--project-root <path>` — Project root directory

**Plan format:**
```markdown
### Task 1: Set up project structure
Create directory layout and package.json.

### Task 2: Implement core logic
Write the main business logic in src/index.ts.
```

---

### `agency workflow <subcommand>`
Compose and run predefined CodexAI workflow script chains.

```
agency workflow list
agency workflow run plan --prompt "design user auth system"
agency workflow run review
agency workflow run deploy --yes
```

**Subcommands:**
- `list` — Print the available workflows and their step chains (`--json`, `--quiet`)
- `run <name>` — Run a workflow chain

**Available workflows:** `create`, `plan`, `debug`, `review`, `deploy`, `handoff`, `refactor`, `prototype`

**Options (`run`):**
- `--project-root <path>` — Project root directory
- `--prompt <text>` — Prompt for the plan workflow's route-plan step
- `--yes` — Approve steps that write artifacts
- `--preflight` — Include the (skipped-by-default) `preflight` runtime-hook step
- `--json` / `--quiet`

> Steps run pack Python scripts (resolved via `python3`/`python`/`py`); a failing gate step (e.g. `review`'s tech-debt, `debug`'s pre-commit) aborts the chain with a clear recovery message.

---

### `agency agents <subcommand>`
Multi-agent orchestrator (fresh context per dispatch).

```
agency agents list
agency agents dispatch backend-specialist --task "implement login endpoint"
agency agents parallel --dispatches '[{"agentId":"planner","task":"Draft plan"}]'
```

**Subcommands:**
- `list` — List available agent roles
- `dispatch <agentId> --task <text>` — Dispatch a single agent in an isolated env
- `parallel --dispatches <json> | --dispatches-file <path>` — Run multiple subagents concurrently with workspace isolation

**Options (`dispatch` / `parallel`):**
- `--project-root <path>` — Project root directory
- `--no-llm` — Force route-only output (skip LLM even if an API key is set)

**Agent roles:** frontend-specialist, backend-specialist, security-auditor, debugger, test-engineer, devops-engineer, planner, scrum-master (plus any custom roles in `.agency/agents.json`)

---

### `agency index`
Index workspace files for context and the `@`-reference system.

```
agency index
agency index --force
```

**Options:**
- `--project-root <path>` — Project root directory
- `--force` — Rebuild the index from scratch (ignore mtime cache)

---

### `agency config <subcommand>`
Manage `~/.agency/config.json` (LLM providers).

```
agency config init
agency config path
agency config show                                  # API keys masked
agency config get providers.openai.model
agency config set defaultProvider openai
agency config set providers.openai.apiKey '${OPENAI_API_KEY}'
agency config unset providers.openai
```

**Subcommands:**
- `init` — Create `~/.agency/config.json` from template if missing (`--force` overwrites)
- `path` — Print the config file path
- `show` — Print the current config with API keys masked
- `get <key>` — Print one value by dotted key (e.g. `providers.openai.model`)
- `set <key> <value>` — Set a value by dotted key (booleans/integers are coerced; `${ENV_VAR}` stays literal)
- `unset <key>` — Remove a value by dotted key

All subcommands accept `--json` and `--quiet`.

> Prefer storing secrets as `${ENV_VAR}` placeholders (resolved from the environment at runtime). `config set …apiKey <raw>` works but prints a tip recommending the placeholder form.

---

### `agency doctor`
TS-native environment preflight — works even when Python is missing. Checks the Python interpreter (`python3`/`python`/`py`), the skills pack, and whether any provider has a resolvable API key, each with an actionable recovery hint.

```
agency doctor
agency doctor --json
agency doctor --deep      # also run the Python skills-pack health check
```

**Options:**
- `--json` — Machine-readable report (`{ ok, checks[] }`)
- `--quiet` — Suppress routing meta on stderr
- `--deep` — Additionally run the Python `pack_health` check (skipped if Python is unavailable)

> Exit code is `1` only when a check **fails** (e.g. no provider key); a missing Python interpreter is a **warning** (the CLI falls back to built-in heuristic routing).

---

### `agency setup`
Initialize Agency CLI in a project and run an initial index.

```
agency setup
agency setup --project-root /path/to/project --force-index
```

**Options:**
- `--project-root <path>` — Project root to index
- `--force-index` — Rebuild workspace index from scratch
- `--json` — Machine-readable JSON output
- `--quiet` — Suppress routing meta on stderr

---

### `agency compact`
Compact / archive old session files to manage token usage.

```
agency compact --dry-run
agency compact --yes
agency compact --max-age-days 30 --keep-latest 10 --yes
```

**Options:**
- `--dry-run` — Preview compaction without writing or deleting files
- `--yes` — Approve mutating compaction (required without `--dry-run`)
- `--max-age-days <n>` — Archive session files older than N days (default: 90)
- `--keep-latest <n>` — Always keep the latest N session files (default: 5)
- `--project-root <path>` — Project root directory

---

### `agency plugin <subcommand>`
Validate and inspect the skills-pack plugin-tools contract.

```
agency plugin validate
agency plugin tools
agency plugin tools -o tools.json
agency plugin schema
```

**Subcommands:**
- `validate` — Validate `plugin-tools.json` against the schema
- `tools` — Print the resolved plugin tools (`-o, --output <file>` to write JSON to a file)
- `schema` — Print the plugin-tools JSON schema

---

### `agency schedule <subcommand>`
Cron-like local workflow scheduler (`.agency/schedules.json`, no background daemon).

```
agency schedule list
agency schedule add --workflow review --every 30m
agency schedule add --workflow deploy --cron "daily:09:00" --require-approval
agency schedule remove <id>
agency schedule run --yes
```

**Subcommands:**
- `list` — List configured schedules
- `add` — Add a schedule (`--workflow <name>` required; `--every <expr>` or `--cron <expr>`; `--require-approval`; `--project-root <path>`)
- `remove <id>` — Remove a schedule by id
- `run` — Run all due schedules now (`--yes` to approve workflows that require approval)

> `--every`: `5m`, `1h`, or a daily time `09:00`. `--cron`: `every:5m`, `daily:09:00`, or a 5-field cron expression.

---

### `agency team <subcommand>`
Manage team configuration.

```
agency team init --name "Platform Team"
agency team show
agency team member add --id alice --name "Alice" --role lead --email alice@example.com
```

**Subcommands:**
- `init --name <name>` — Initialize team config
- `show` — Show team configuration
- `member add` — Add a member (`--id`, `--name`, `--role` required; `--email` optional)

---

### `agency routing <subcommand>`
Inspect routing weights and record feedback for self-learning.

```
agency routing weights
agency routing feedback --prompt "fix the failing login test" --intent fix_bug
```

**Subcommands:**
- `weights` — Display learned routing weights
- `feedback --prompt <text> --intent <name>` — Record a misrouted prompt + its correct intent (both required)

---

### `agency browser <subcommand>`
Browser automation MCP status + URL opening.

```
agency browser status
agency browser open https://example.com
agency browser open https://example.com --system
```

**Subcommands:**
- `status` — Show browser MCP status
- `open <url>` — Open a URL (`--system` uses the system default browser)

---

### `agency graph`
Load and display the knowledge graph.

```
agency graph
```

**Options:**
- `--project-root <path>` — Project root directory

---

### `agency git <subcommand>`
Git repository intelligence.

```
agency git summary
agency git pr
agency git pr --create
```

**Subcommands:**
- `summary` — Branch, status, and recent commits
- `pr` — PR status (`--create` prints guidance to create a PR with `gh`)

---

### `agency memory <subcommand>`
Project memory / knowledge bridge.

```
agency memory status
agency memory build --yes
agency memory genome --depth auto
```

**Subcommands:**
- `status` — Validate `.agency/knowledge` (or `.codex/knowledge`) artifacts for staleness/coherence
- `build` — Build the knowledge index from project sources (`--yes` to approve writes)
- `genome` — Generate layered project context docs (`--depth <mode>`, default `auto`)

---

### `agency benchmark [task-id]`
Run isolated evaluation benchmarks or list available tasks.

```
agency benchmark --list
agency benchmark file-analysis
agency benchmark ast-search --json --budget 2.0
```

**Tasks:** `file-analysis`, `ast-search`, `script-compilation`

**Options:**
- `--list` — List all available benchmark tasks
- `--json` — Output results in raw JSON
- `--budget <amount>` — Maximum spend budget in USD (default: `5.0`)

---

### `agency replay`
Replay the recorded durable event journal (`.agency/events/journal.db`) and verify it has not diverged or been corrupted — each event's payload must still hash to its stored `payloadHash`. The §2.5 behaviour-replay foundation. Exits non-zero on divergence.

```
agency replay
agency replay --json
agency replay --project-root ./some/project
```

**Options:**
- `--project-root <path>` — Project root directory
- `--json` — Emit the result (`{ ok, total, verified, skipped, divergence? }`) as JSON

Oversized events whose payload was spilled to disk are counted as `skipped` (their hash covers the original, not the inline ref), never flagged as failures.

---

## TUI Slash Commands (Interactive Mode Only)

| Command | Action |
|---------|--------|
| `/help` | Open help overlay (slash commands, key bindings) |
| `/new` | Create new clean session |
| `/connect` | Open API key/provider configuration overlay |
| `/models` | Open model selection overlay |
| `/skills` | Browse and inject skills into prompt |
| `/plugin` | View installed skill packs |
| `/review [type]` | Code review: commit, branch, PR, CI |
| `/status` (alias `/viewstatus`) | System telemetry dashboard |
| `/mcp` | Manage MCP server configurations |
| `/variant [value]` | Select model thinking budget |
| `/theme [id]` | Switch theme: `agency` or `daylight` |
| `/sessions` | Browse and resume/delete past sessions |
| `/project` | Switch between recent projects |
| `/goal <task>` | Launch multi-step autonomous task |
| `/schedule every X <task>` | Create recurring workflow schedule |
| `/agents` | View subagent dispatch history |
| `/route [feedback <intent>]` | Open route feedback selector |
| `/dashboard` (alias `/memory`) | Open browser knowledge & memory dashboard |
| `/index` | Run workspace index |
| `/compact [dry]` | Compact conversation context |
| `/export` | Export session to markdown |
| `/exit` | Quit application |

## TUI Key Bindings

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+C` | Global | Exit |
| `Ctrl+Q` | Global | Exit |
| `Ctrl+H` / `?` | Buffer empty | Help overlay |
| `Ctrl+O` | Global | Toggle expanded/compact conversation view |
| `Ctrl+X` | Subagents active | Focus first subagent |
| `Tab` | Buffer empty | Cycle agent mode (agent → plan → debug → ask) |
| `Ctrl+D` | Buffer empty | Cycle disclosure level (default → advanced → expert) |
| `Enter` | Buffer non-empty | Submit prompt |
| `↑/↓` | Buffer empty | Scroll conversation (also fed by mouse wheel via alternate-scroll) |
| `PageUp` / `Ctrl+↑` | Global | Scroll up a page |
| `PageDown` / `Ctrl+↓` | Global | Scroll down a page |
| `Esc` | Loading | Abort stream |
| `Esc` | Indexing | Abort index |
| `y` / `a` / `n` | Approval mode | Approve once / approve all / deny |
