# Agency CLI — Configuration & State Management

## Overview

Agency CLI uses a hybrid persistence model: JSON files for configuration and lightweight state, SQLite for memory/vector/graph data, and in-memory objects for runtime state. Configs live at two levels: global (`~/.agency/`) and project (`$PROJECT/.agency/`).

---

## 1. Global Configuration (`~/.agency/`)

### `~/.agency/config.json`
**Managed by:** `packages/providers/src/config.ts` — `loadAgencyConfig()`
**CLI entry:** `agency config init`

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-3-5-sonnet-20241022",
      "thinking": "medium"
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "model": "gpt-4o-mini"
    },
    "google": {
      "apiKey": "${GOOGLE_API_KEY}",
      "model": "gemini-2.0-flash"
    },
    "openrouter": {
      "apiKey": "${OPENROUTER_API_KEY}",
      "model": "meta-llama/llama-3-70b-instruct"
    },
    "nvidia": {
      "apiKey": "${NVIDIA_API_KEY}",
      "model": "meta/llama3-70b-instruct"
    },
    "local": {
      "model": "llama3.2"
    }
  }
}
```

**Key resolution:** `${ENV_VAR}` placeholders replaced with `process.env` values at runtime (recommended). Raw keys are accepted but warned against (TUI `/connect` and `agency config set` both recommend the placeholder form); keys are masked in `agency config show`.

**Default:** When file doesn't exist: `{ defaultProvider: "anthropic", providers: {} }`

### `~/.agency/tui.json`
**Managed by:** `packages/tui/src/config/tui-config.ts` — `loadTuiConfig()`

```json
{
  "theme": "agency",
  "leader": ""
}
```

- `theme`: `"agency"` or `"daylight"` (persisted after `/theme` switch)
- `leader`: Reserved for future use
- **Priority:** Project-level override → global fallback

### `~/.agency/mcp.json`
**Managed by:** `packages/core/src/mcp/config.ts` — `loadMcpConfigs()`

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/files"],
      "env": { "CUSTOM_VAR": "value" }
    }
  }
}
```

- `env` values use both `${VAR}` and `%VAR%` resolution
- **Priority:** Project-level MCP servers override global ones by name

---

## 2. Project-Level State (`$PROJECT/.agency/`)

All project-local state persists under the `.agency/` directory in the workspace root.

### Complete File Inventory

| File | Owner | Purpose |
|------|-------|---------|
| `.agency/index.json` | `core/src/index/` | Workspace file index |
| `.agency/index.lock` | `core/src/index/` | Index write concurrency lock |
| `.agency/team.json` | `core/src/team/` | Team member definitions |
| `.agency/schedules.json` | `core/src/scheduler/` | Recurring workflow schedules |
| `.agency/routing-weights.json` | `core/src/router/` | Learned routing intent signals |
| `.agency/mcp.json` | `core/src/mcp/` | Project-specific MCP servers |
| `.agency/tui.json` | `tui/src/config/` | Project-specific TUI settings |
| `.agency/audit.jsonl` | `core/src/approval/` | Append-only action audit log |
| `.agency/session/route-cache.json` | `core/src/context/` | SHA-256 routing result cache |
| `.agency/sessions/sess-*.json` | `tui/src/sessions/` | Full chat session transcripts |
| `.agency/tasks/*.json` | `core/src/task/` | Task checkpoints |
| `.agency/agents/dispatch-*.json` | `core/src/agents/` | Agent dispatch records |
| `.agency/events/journal.db` | `core/src/events/` | SQLite event journal |
| `.agency/memory/memory.db` | `memory/src/` | SQLite memory database |
| `.agency/goal-plan.md` | `tui/src/App.tsx` | Goal runner temporary plan file |

---

## 3. File Schemas

### Workspace Index (`index.json`)
```json
{
  "version": 1,
  "generatedAt": 1700000000000,
  "files": [
    {
      "path": "src/index.ts",
      "language": "typescript",
      "mtime": 1700000000000,
      "size": 1234,
      "hash": "abc123...",
      "symbols": ["export class App", "export function main"]
    }
  ],
  "stats": {
    "totalFiles": 150,
    "indexDurationMs": 450,
    "languages": { "typescript": 80, "python": 30, "markdown": 20 }
  }
}
```

### Team (`team.json`)
```json
{
  "members": [
    {
      "id": "lead-1",
      "name": "Alice",
      "role": "lead",
      "email": "alice@example.com"
    }
  ],
  "policies": {
    "requireApprovalForDeploy": true,
    "autoGateEvery": 3
  }
}
```

### Schedules (`schedules.json`)
```json
{
  "entries": [
    {
      "id": "sched-uuid",
      "workflow": "review",
      "cron": "0 */6 * * *",
      "projectRoot": "/path/to/project",
      "createdAt": 1700000000000,
      "lastRunAt": null,
      "enabled": true
    }
  ]
}
```

### Routing Weights (`routing-weights.json`)
```json
{
  "version": 1,
  "signals": {
    "implement_feature": {
      "skillWeights": { "codex-plan-writer": 0.8, "codex-test-driven-development": 0.6 },
      "agentWeights": { "backend-specialist": 0.9, "planner": 0.7 }
    }
  },
  "feedbackHistory": [
    {
      "timestamp": 1700000000000,
      "originalRoute": { "intent": "fix_bug", "suggestedAgent": "backend-specialist" },
      "correctedRoute": { "suggestedAgent": "debugger" },
      "source": "user"
    }
  ]
}
```

### MCP Config (`mcp.json`)
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

### Audit Log (`audit.jsonl` — Append-only, one JSON object per line)
```jsonl
{"timestamp":"2024-01-01T00:00:00Z","action":"shell_exec","command":"npm install","approved":true,"user":"cli"}
{"timestamp":"2024-01-01T00:01:00Z","action":"file_write","path":"src/index.ts","approved":true}
```

---

## 4. SQLite Databases

### Memory Database (`$PROJECT/.agency/memory/memory.db`)
**Managed by:** `packages/memory/src/db.ts`

**Connection config:** WAL mode, NORMAL synchronous, shadow backup at `.db.shadow`

**Tables (v1 migration):**

| Table | Columns | Indexes |
|-------|---------|---------|
| `episodes` | id, tenant, session, agent, type, goal, content, state, transition, lamport_clock, parent_id, created_at, expires_at, metadata | tenant+session, agent, type, state |
| `episodes_fts` | content, goal (FTS5 virtual table) | FTS5 index |
| `vectors` | id, episode_id, vector (JSON float[]), dimension, created_at | episode_id, dimension |
| `graph_edges` | id, source_id, target_id, relation_type, weight, created_at | source+target, relation_type |
| `event_log` | id, sequence, action, payload, timestamp | sequence |
| `audit_log` | id, operation, entity_type, entity_id, pre_state, post_state, timestamp | entity_type+entity_id |
| `quarantined_vectors` | id, vector, dimension, reason, timestamp | dimension |
| `schema_migrations` | version (PRAGMA user_version) | — |

### Event Journal (`$PROJECT/.agency/events/journal.db`)
**Managed by:** `packages/core/src/events/event-journal.ts`

**Tables:**

| Table | Columns |
|-------|---------|
| `events` | sequence_id (auto), timestamp, action, payload_hash (SHA-256), payload (JSON) |
| `checkpoints` | state_name (PK), state_data (JSON) |

---

## 5. In-Memory Runtime State

### Event Bus (`packages/core/src/events/event-bus.ts`)
- **Pattern:** Singleton pub/sub
- **Dedup:** SHA-256 hash, 5s sliding window
- **Topics:** `*` wildcard + specific actions
- **Journal:** In-memory `ReplayEvent[]` with monotonic sequence

### Workspace Lock Manager (`packages/workspace/src/lock-manager.ts`)
- **Pattern:** In-memory file-level locks with queuing
- **Config:** 15s default timeout, auto-release safety timer
- **API:** `acquireLock(path)`, `releaseLock(path)`, `withLock(path, fn)`

### Write Queue (`packages/memory/src/write-queue.ts`)
- Serializes SQLite write operations to prevent contention
- FIFO ordering
- Error propagation to callers

### TUI Session Persist Queue (`packages/tui/src/sessions/persist-queue.ts`)
- Debounced save: 450ms default interval
- Pending session batched and written to disk
- Prevents excessive disk I/O during rapid message updates

### Telemetry Tracker (`packages/telemetry/src/tracker.ts`)
```typescript
interface ActiveTelemetryTracker {
  sessionGoal: string;
  turns: { prompt: string; durationMs: number; tokensUsed: number }[];
  toolCalls: { name: string; args: any; result: string; durationMs: number }[];
  gitHash: string;
  providerSeed: number;
}
```

### TUI State (`packages/tui/src/state/`)

#### Agent Modes (`agent-modes.ts`)
| Mode | Color | Budget | Description | Skill Prefix |
|------|-------|--------|-------------|-------------|
| `agent` | `#58a6ff` (blue) | `deep` | Full agent — plan, search, analyze & build | None |
| `plan` | `#d29922` (amber) | `normal` | Architecture & implementation planning | `$plan` |
| `debug` | `#f85149` (red) | `normal` | Systematic debugging & root cause analysis | `$debug` |
| `ask` | `#3fb950` (green) | `normal` | Ask anything about the codebase | None |

#### Messages (`messages.ts`)
```typescript
interface SessionMessage {
  id: string;           // timestamp + random suffix
  role: "user" | "assistant" | "system";
  content: string;
  presentation?: {
    chips?: Chip[];
    suggestions?: string[];
    cacheHint?: "cached";
  };
  streaming?: boolean;
  timestamp: number;
}
```

#### Context Tracker (`context-tracker.ts`)
- **Token estimate:** 4 chars/token heuristic
- **Activity phases:** idle → routing → exploring → reading → analyzing → thinking → writing → editing
- **Context window lookup:** via provider registry model specs

#### Disclosure Provider (`DisclosureProvider.tsx`)
3 progressive disclosure levels:
1. `default` — Minimal UI information
2. `advanced` — Moderate detail
3. `expert` — Full debug information

#### Heartbeat Provider (`HeartbeatProvider.tsx`)
- Tracks silence budget (3s threshold)
- `isSilent` flag for momentum-preserving indicators

---

## 6. Caching Layers

| Cache | Scope | TTL | Backend |
|-------|-------|-----|---------|
| Route Cache | Project → `.agency/session/route-cache.json` | 1 hour | JSON file (SHA-256 keyed) |
| Memory LRU Cache | Runtime (process heap) | 5 min | `lru-cache` npm, max 500 entries |
| Provider Rate Limiter | Runtime per model | Dynamic | In-memory request counter |
| Session Persist Queue | Runtime | 450ms debounce | In-memory pending session |
| @-reference Fuzzy Cache | Runtime per query | 1 turn | In-memory Map |

---

## 7. State Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│  USER INPUT                                              │
│  (TUI Composer / CLI command)                            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  SESSION STATE (in-memory)                               │
│  • AgencySession.messages[]                              │
│  • buffer, agentMode, pendingApproval                    │
│  • loading, activityPhase, tokenCount                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  EVENT BUS (pub/sub, in-memory)                          │
│  • subagent:started/progress/finished → SubagentPanel    │
│  • dag:task:started/completed/failed                     │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │ Router  │ │Context  │ │Provider │
    │ weights │ │ Pack    │ │Config   │
    │.json    │ │ Builder │ │.json    │
    └────┬────┘ └────┬────┘ └────┬────┘
         │           │           │
         ▼           ▼           ▼
    ┌─────────────────────────────────────┐
    │  LLM PROVIDER (API call)            │
    │  • CostGovernor tracks spending     │
    │  • ProviderSupervisor health check  │
    └────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  FILE SYSTEM OPERATIONS                                  │
│  • LockManager → StagingEngine → commit/rollback         │
│  • Workspace indexer → .agency/index.json                │
│  • Audit trail → .agency/audit.jsonl                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  MEMORY PIPELINE                                         │
│  • Episode → SQLite episodes                             │
│  • Vector → SQLite vectors (cosine similarity)           │
│  • Graph edges → SQLite graph_edges                      │
│  • CRDT merger for multi-agent reconciliation            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  PERSISTENCE                                             │
│  • Session saved → .agency/sessions/sess-*.json (450ms   │
│    debounce)                                             │
│  • Task checkpoint → .agency/tasks/*.json                │
│  • Agent dispatch → .agency/agents/dispatch-*.json       │
│  • Event journal → .agency/events/journal.db             │
└─────────────────────────────────────────────────────────┘
```

---

## 8. Security & Key Management

### API Key Storage
- **Pattern:** `${ENV_VAR}` placeholders in JSON config
- **Resolution:** `resolveApiKey()` regex: `/\$\{([A-Z0-9_]+)\}/g`
- **MCP env resolution:** Also supports `%VAR%` (Windows style)
- **Raw keys allowed but warned:** `/connect` and `config set` recommend `${ENV_VAR}`; keys are masked in `config show`/`get`

### Memory Encryption (`packages/memory/src/security.ts`)
- `SecurityHardening` class with AES-256-GCM
- Requires 64-char hex encryption key
- Encrypts sensitive payloads before SQLite write
- Decrypts on retrieval

### Approval Policies
- Destructive command detection: 23 regex patterns in `DENY_PATTERNS`
- File write approval: `y` (approve), `n` (deny), optional auto-approve list
- Shell command approval: `y` (execute once), `n` (deny), `--yes` flag (headless)

---

## 9. Configuration Priority Rules

### MCP Config
```
Project .agency/mcp.json > Global ~/.agency/mcp.json
Servers deduplicated by name (project wins)
```

### TUI Config
```
Project .agency/tui.json > Global ~/.agency/tui.json
```

### Provider Config
```
Global ~/.agency/config.json only (no project override for security)
```

### API Keys
```
Environment variable > Config placeholder > Undefined (provider unavailable)
```

---

## 10. External / Read-only State

Directories not managed by Agency CLI itself but present in project:

- **`.codex/quality/gate-events.jsonl`** — External Codex quality gate events
- **`.codex/state/gate_state.json`** — `{ consecutive_failures: N }`
- **`.commandcode/taste/taste.md`** — External taste/learning system placeholder

---

## 11. Session Lifecycle

```
1. App launch
   └─ loadLatestSession(project)
       ├─ Finds most recent sess-*.json
       └─ Or creates new session: createSession(project)
           └─ { id: uuid, messages: [], createdAt, project }

2. During conversation
   └─ Every message add → updateSession()
       └─ saveSession(session) — debounced 450ms
           └─ Write .agency/sessions/sess-<id>.json

3. Session switch
   ├─ /new → createSession() + clear route cache
   ├─ /sessions → listSessionSummaries() → pick → loadSession()
   └─ Ctrl+D delete on session picker → deleteSession()

4. Export
   └─ /export → format as markdown → write to disk
```

---

## 12. Workspace Index Lifecycle

```
1. Auto-index on main phase
   └─ isIndexStale() → incrementalUpdateAsync()
       └─ Scans mtimes, re-indexes changed files only
       └─ writeIndex() → .agency/index.json

2. Manual re-index
   └─ /index slash command
       └─ incrementalUpdateAsync() with progress display

3. Post-file-edit re-index
   └─ After approved file write:
       └─ buildIndex() → writeIndex()

4. Index consumption
   └─ @-reference autocomplete: fuzzySearchFiles()
   └─ Context pack building: loadIndex()
   └─ Language stats display
```
