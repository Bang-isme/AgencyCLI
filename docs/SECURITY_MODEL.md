# Agency CLI — Security Model

## Overview

Agency CLI implements defense-in-depth with **3 independent security layers**: approval gating, security escalation, and execution sandboxing. Every potentially destructive operation — shell commands, file writes, skill tool invocation, and workflow steps — passes through this triple-layer checkpoint.

---

## Layer 1: Approval Policy

**Location:** `packages/core/src/approval/`

### Destructive Command Detection

`DENY_PATTERNS` — 23 regex patterns covering all categories of destructive shell commands:

| Category | Patterns |
|----------|----------|
| **File / disk deletion** | `rm -rf`, `del /f`, `del /s`, `rd /s`, `format`, `diskpart`, `mkfs`, `dd if=` |
| **System modification** | `chmod -R 777 /`, `chown -R ... /` |
| **System shutdown** | `shutdown`, `reboot`, `poweroff`, `init 0` |
| **Fork bombs** | `:(){ :\|:& };:` |
| **Remote code execution** | `curl ... \| sh`, `wget ... \| sh` |
| **Process termination** | `taskkill ... node`, `killall/pkill node`, `kill 0/-1`, `Stop-Process ... node`, `spps ... node`, `wmic ... node delete/terminate` |

### Policy Functions

| Function | Purpose |
|----------|---------|
| `requiresApproval(cmd)` | Returns `true` if command matches DENY_PATTERNS or performs writes |
| `assertApproval(cmd, opts?)` | Throws `ApprovalRequiredError` unless `opts.yes === true` |
| `isDestructiveCommand(cmd)` | Pure pattern matching against all 23 DENY_PATTERNS |

### Approval Flow

```
User Action (shell command, file write, skill tool, workflow step)
    │
    ▼
requiresApproval(action)
    ├─ DENY_PATTERNS match? ──→ approval required
    ├─ safety_policy.writes_artifacts? ──→ approval required
    ├─ workflow.step.requiresApproval? ──→ approval required
    └─ otherwise ──→ allowed (read-only)
    │
    ▼
[CLI headless]
    ├─ --yes flag? ──→ allowed
    └─ otherwise ──→ ApprovalRequiredError thrown

[TUI interactive]
    ├─ y ──→ approve once
    ├─ n ──→ deny
    ├─ y* ──→ approve all (auto-approve list)
    └─ n* ──→ deny all (deny list)
```

### Audit Trail

Every approval decision is recorded to `.agency/audit.jsonl` (append-only):

```jsonl
{"timestamp":"2024-01-01T00:00:00Z","action":"shell_exec","command":"npm install","approved":true,"user":"cli"}
{"timestamp":"2024-01-01T00:01:00Z","action":"file_write","path":"src/index.ts","approved":false}
```

---

## Layer 2: Full Approval Policy Engine

**Location:** `packages/core/src/approval/approval-policy-engine.ts`

The `ApprovalPolicyEngine` adds **progressive autonomy** on top of basic approval:

### Autonomy Modes

| Mode | Behavior |
|------|----------|
| `safe` | Every action requires approval |
| `balanced` | LOW-risk actions auto-approved after 2 manual approvals |
| `autonomous` | LOW + MEDIUM auto-approved; only HIGH requires approval |
| `ci` | All actions auto-approved (CI/CD bypass) |

### Progressive Autonomy Escalation

```
Manual approval streak (3+ successful validations)
    → escalate to next autonomy level

Confidence decay (score < 0.7)
    → downgrade one level

Confidence collapse (score < 0.4)
    → downgrade to safe
```

### Sticky Denials

Once a user denies a file write within a session, all subsequent writes to the same file on the same branch are auto-rejected for the session lifetime. Cleared on manual mode escalation.

### Continuation Policies (Timeout Behavior)

| Policy | On Timeout |
|--------|-----------|
| `proceed_autonomous` | Auto-approve action |
| `readonly_fallback` | Revert to read-only mode |
| `reject` | Auto-reject action |

### Risk Assessment

`RiskAssessor.assessRisk(action, params)` evaluates 5 dimensions:

| Dimension | Criteria |
|-----------|----------|
| `filesystem` | Write/delete/patch operations on file system |
| `shell` | Command execution with potential side effects |
| `network` | URL/fetch operations |
| `privilege` | sudo usage, native sandbox mode |
| `destructive` | Known destructive patterns |

Final score: `70% × max(dimensions) + 30% × average(dimensions)`, adjusted by `RiskHeuristicRefiner` from `@agency/heuristics` (±0.3 per dimension based on user feedback).

---

## Layer 3: Security Escalation

**Location:** `packages/security/src/security-escalation.ts`

### 5 Security Levels

Every tool in the system is classified into one of five levels:

| Level | Name | Allowed Operations |
|-------|------|-------------------|
| **Level 1** | Safe | Pure computation (math, status, permissions list) |
| **Level 2** | ReadOnly | File reads, directory listings, grep searches |
| **Level 3** | WorkspaceWrite | File creates, edits, replacements within workspace |
| **Level 4** | Network | URL reads, web searches, URL execution |
| **Level 5** | Privileged | Shell command execution (requires sandbox) |

### Tool Registry

| Tool | Level |
|------|-------|
| `math`, `status`, `list_permissions` | Level 1 |
| `view_file`, `list_dir`, `grep_search`, `read_resource` | Level 2 |
| `write_to_file`, `replace_file_content`, `multi_replace_file_content` | Level 3 |
| `read_url_content`, `search_web`, `execute_url` | Level 4 |
| `run_command` | Level 5 |

### Fallback Heuristic (for unmapped tools)
- Contains `write`/`patch`/`delete`/`edit` → Level 3
- Contains `read`/`get`/`view`/`list` → Level 2
- Contains `run`/`exec`/`command`/`shell` → Level 5
- Otherwise → Level 3

### Access Control

```typescript
SecurityEscalationManager.checkAccess(toolName, maxAllowedLevel, whitelist?)
    → SecurityCheckResult { allowed: boolean; toolLevel; reason? }
```

A tool is allowed if:
1. Its registered level ≤ `maxAllowedLevel`, OR
2. It's in the `whitelist` Set

---

## Layer 4: Execution Sandbox

**Location:** `packages/security/src/sandbox.ts`

### NativeSandbox

- Spawns command with `shell: true` in `projectRoot`
- Pipes stdio directly (or captures if `capture: true`)
- Requires **Level 5** clearance
- Full host access — use only for trusted commands

### DockerSandbox

Creates an isolated container with:

| Feature | Implementation |
|---------|---------------|
| **Filesystem** | Volume mount: `-v projectRoot:/workspace` (optionally `:ro`) |
| **Network** | `--network none` (when `networkDisabled: true`) |
| **Memory** | `-m <value>` (from `memoryLimit` option) |
| **CPU** | `--cpus <value>` (from `cpuLimit` option) |
| **Environment** | `-e KEY=VAL` (from `env` map) |
| **Image** | Default `node:22-alpine` (override via `image` option) |
| **Auto-cleanup** | `--rm` flag |

### Sandbox Options

```typescript
interface SandboxOptions {
  projectRoot: string;
  image?: string;          // Docker image (default: node:22-alpine)
  networkDisabled?: boolean; // Block all network access
  readOnly?: boolean;       // Mount filesystem as read-only
  memoryLimit?: string;     // e.g., "512m"
  cpuLimit?: string;        // e.g., "1.0"
  env?: Record<string, string>;
  capture?: boolean;        // Return stdout/stderr instead of piping
}
```

### CLI Integration

```bash
# Native sandbox (default, requires approval)
agency run "npm test" --yes

# Docker sandbox
agency run "npm test" --sandbox-mode docker --yes

# Docker with memory/network restrictions
agency run "npm install" \
  --sandbox-mode docker \
  --docker-memory 512m \
  --docker-cpu 1.0 \
  --docker-network-disabled \
  --yes
```

---

## Network Egress & Process Jail

**Location:** `packages/security/src/egress-proxy.ts`, `packages/security/src/process-jail.ts`

### EgressFilterProxy

A domain-allowlist proxy for outbound network access. `matchGlob(domain, pattern)` supports wildcard patterns (e.g. `*.example.com`); requests to domains outside the allowlist are blocked. Configured via `EgressFilterProxyOptions`.

### ProcessJail

Restricts the capabilities of spawned child processes (e.g. environment scrubbing, working-directory confinement) so sandboxed commands cannot escalate beyond their granted clearance.

---

## Memory Encryption

**Location:** `packages/memory/src/security.ts`

### SecurityHardening

- **Algorithm:** AES-256-GCM
- **Key:** 64-char hex string (must be provided externally)
- **API:** `encrypt(plaintext, key) → { ciphertext, iv, tag }`, `decrypt(ciphertext, iv, tag, key) → plaintext`

Used for encrypting sensitive memory payloads before storage in SQLite.

---

## Secret Detection

**Location:** `packages/memory/src/ingestion.ts`

`IngestionPipeline.detectSecrets(content)` scans for:

| Pattern | Type |
|---------|------|
| `AIza[0-9A-Za-z-_]{35}` | Google API key |
| `xox[bapr]-[0-9A-Za-z-]{10,}` | Slack token |
| `AKIA[0-9A-Z]{16}` | AWS Access Key |
| `SK[0-9a-fA-F]{32}` | Generic secret keys |
| `eyJ...` patterns | JWT bearer tokens |

---

## Loop Detection

**Location:** `packages/heuristics/src/loop-heuristics.ts`

`LoopDetector` catches 3 categories of infinite agent loops:

| Category | Detection | Rolling Window |
|----------|-----------|---------------|
| Consecutive identical errors | Last 3 errors byte-identical | 10 errors |
| Consecutive identical prompts | Last 3 prompts byte-identical | 10 prompts |
| Back-and-forth patch cycle | Patch hash A→B→A→B on same file | Per-file patch history (10) |

---

## API Key Management

- Keys are **recommended** to be stored as `${ENV_VAR}` placeholders in `~/.agency/config.json`, resolved at runtime from `process.env`
- Raw keys are still accepted (TUI `/connect` and `agency config set`) but both **warn** and recommend the placeholder form — so plaintext-on-disk is a deliberate, surfaced choice, not silent
- API keys are masked in `agency config show` / `config get` output
- MCP env variables support both `${VAR}` and `%VAR%` patterns
- Resolution regex: `/\$\{([A-Z0-9_]+)\}/g`

---

## Security Summary

```
Every destructive operation passes through:

Layer 1: Approval Policy
    └─ DENY_PATTERNS (23 regex) + policy engine
        ├─ Autonomy modes (safe/balanced/autonomous/ci)
        ├─ Risk assessment (5 dimensions)
        ├─ Sticky denials (session-lifetime)
        └─ Audit trail (JSONL, append-only)

Layer 2: Security Escalation
    └─ 5-level tool classification
        └─ Whitelist bypass support

Layer 3: Execution Sandbox
    └─ NativeSandbox (Level 5 only, with approval)
    └─ DockerSandbox (network isolation, resource limits, read-only FS)
    └─ EgressFilterProxy (domain-allowlist) + ProcessJail (child-process capability limits)
```
