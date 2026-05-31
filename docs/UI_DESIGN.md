# Agency CLI — UI/UX Design

## Technology Foundation

| Layer | Technology |
|-------|-----------|
| UI Framework | React 18.3 + Ink 5.0 (React reconciliation → ANSI terminal) |
| Rendering | Ink's `render()` → alternate screen buffer (`\x1b[?1049h`) |
| Component Model | Functional components with hooks, `memo()` for perf |
| Styling | `ThemeTokens` object via props (no CSS); Ink's `Box` flexbox + `Text` color |
| Themes | 2 predefined: `"agency"` (GitHub-dark) and `"daylight"` (light mode) |
| Animation | Custom tick engine (`useTick`) + a tight motion identity (`motion/design-system.ts`) |
| Input | Ink `useInput` (keyboard) + grapheme-aware text; mouse wheel via terminal alternate-scroll |
| Terminal | `enterAlternateScreen()` / `leaveAlternateScreen()` — alt buffer + alternate-scroll (`?1007h`) |

---

## Phase Flow

```
SPLASH ──(animation done)──→ WELCOME ──(select)──→ MAIN
                                │                      │
                                └─(resume overlay)─────┘
```

| Phase | Component | Purpose |
|-------|-----------|---------|
| **Splash** | `Splash.tsx` (384 lines) | Cyberpunk BIOS boot animation with staged reveals, version/project display |
| **Welcome** | `WelcomeMenu.tsx` | 3-option menu: New Worktree / Resume Session / Quit (mouse+keyboard) |
| **Main** | `Shell.tsx` + overlays | Full chat interface with composer, conversation, status bar |

---

## Complete Component Tree

```
render()
└─ TerminalLayoutProvider       ← measures stdout cols/rows, resize debounce (120ms)
   └─ DisclosureProvider        ← progressive disclosure: default → advanced → expert (Ctrl+D)
      └─ HeartbeatProvider      ← silence budget (3s idle detection)
         └─ App                 ← THE MONOLITH: ~2.6k lines, all state + orchestration
            └─ TerminalViewport ← full-viewport Box with overflow:hidden
               ├─ [Splash]      ← phase="splash" → cyberpunk boot animation
               ├─ [WelcomeMenu] ← phase="welcome" → 3-option menu
               ├─ [SessionPicker] ← resumeOpen overlay at welcome
               └─ Shell         ← phase="main" → permanent chrome
                  ├─ Header          ← "acg v0.1.0" + project path + divider
                  ├─ [ErrorBanner]   ← inline error notifications
                  ├─ [Approval]      ← y/n file-write & shell command approval
                  ├─ MemoConversation ← virtual-line scrolling message list
                  ├─ [CognitionPanel] ← collapsible runtime thought log (3 disclosure levels)
                  ├─ [ExecutionPanel] ← phase/severity execution panel (lifecycle + severity glyphs)
                  ├─ [ToolActivity]  ← spinner + phase + elapsed + token count
                  ├─ [GoalRunner]    ← multi-step goal progress with energy bar
                  ├─ [IndexProgress] ← workspace index scan indicator
                  ├─ ComposerBlock   ← input stack (SlashMenu + AtPicker + PromptComposer)
                  └─ StatusBar       ← left: mode/phase, center: workers, right: model/context%
```

---

## Layout System

**Location:** `packages/tui/src/layout/`

### `TerminalLayoutProvider` (`terminal-layout.ts`)
Pure math, no React rendering:
- `measureTerminal(cols, rows)` → `TerminalLayout` with computed dimensions
- Safe margin of 1 column to prevent Windows Terminal scrollbar flicker (Yoga rounding)
- `panelWidth()` caps overlays at 40–96 columns

### `TerminalLayoutProvider.tsx` (React Context)
- Reads `useStdout()` from Ink, emits `TerminalLayout`
- Debounces resize events at 120ms (`COLS_BUMP_MS`)
- Exported via `useTerminalLayout()` hook

### `Shell.tsx` (Main Chrome Layout)
```
┌─────────────────────────────────────┐
│  Header (flexShrink=0)              │  "acg v0.1.0" project-path
├─────────────────────────────────────┤  accent divider
│                                     │
│  children (flexGrow=1)              │  conversation area
│                                     │
├─────────────────────────────────────┤  accent divider
│  ComposerBlock (flexShrink=0)       │  input stack
│  StatusBar                          │  bottom bar
├─────────────────────────────────────┤
│  esc pause · ctrl+c safe stop       │  footer
└─────────────────────────────────────┘
```

### `ComposerStack.tsx`
Fixed-width bottom stack wrapper for the input area.

### `TerminalViewport.tsx`
Full-height Box using `shellWidth` × `shellHeight`.

---

## Theme System

**Location:** `packages/tui/src/themes/registry.ts`

### Theme Tokens
```typescript
interface ThemeTokens {
  bg: string;        // Background
  panel: string;     // Panel surfaces
  border: string;    // Border color
  dimBorder: string; // Subtle borders
  text: string;      // Primary text
  muted: string;     // Secondary/muted text
  accent: string;    // Accent/highlight
  highlight: string; // Active selection
  success: string;   // Success indicators
  warning: string;   // Warning indicators
  danger: string;    // Error/destructive
}
```

### Themes

| Theme | BG | Accent | Vibe |
|-------|-----|--------|------|
| `agency` (default) | `#0d1117` (GitHub dark) | `#58a6ff` (blue) | Developer terminal |
| `daylight` | `#fbfaf8` (light) | `#0969da` (blue) | Light mode |

Switched via `/theme <id>` slash command. Persisted in `~/.agency/tui.json`.

---

## Input Architecture

**Location:** `packages/tui/src/App.tsx` — main `useInput` handler

### Input Priority Order
```
1. Phase guard          — splash → do nothing; welcome → arrow/enter/esc for menu
2. Indexing abort       — escape aborts index scan
3. Picker active        — slash-menu/@-picker navigation via tab/arrows
4. Global shortcuts     — Ctrl+C exit, ? help toggle, Ctrl+Q exit
5. Scroll arrows        — up/down when buffer empty (conversation scroll)
6. Approval keys        — y/n for pending approval
7. Resume picker        — escape/arrows/enter/Ctrl+D delete
8. Project picker       — escape/arrows/enter
9. Overlay guard        — block all input if any overlay open
10. Loading guard        — escape aborts stream
11. Tab                  — cycle agent mode (agent → plan → debug → ask)
12. Ctrl+D               — cycle disclosure level (default → advanced → expert)
13. Enter                — submit prompt
14. Physical backspace   — deleteLastGrapheme()
15. Control shortcuts    — filtered (Ctrl+A, Ctrl+Z excluded)
16. Text input           — grapheme-aware character insertion + IME
```

### Secondary Input Handlers
- `ComposerBlock.tsx` — separate `useInput` for slash-menu and @-picker
- Each overlay has its own `useInput` for navigation
- Mouse wheel: not handled in JS — the terminal's **alternate-scroll mode** (`?1007h`)
  translates the wheel into ↑/↓ arrow keys, which the conversation scroll already handles
  (see *Mouse Support* below). No in-JS mouse/SGR parser exists anymore; `App.tsx` keeps only
  a short comment documenting how to restore click-to-select (re-enable `?1000h`/`?1006h` and
  reinstate an SGR parser on Ink's `internal_eventEmitter`).

### Key Bindings
| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+C` | Global | Exit |
| `Ctrl+Q` | Global | Exit |
| `Ctrl+H` / `?` | Buffer empty | Help overlay |
| `Ctrl+O` | Global | Toggle expanded/compact conversation view |
| `Ctrl+X` | Subagents active | Focus first subagent |
| `Tab` | Buffer empty | Cycle agent mode |
| `Ctrl+D` | Buffer empty | Cycle disclosure level |
| `Enter` | Buffer non-empty | Submit prompt |
| `↑/↓` | Buffer empty | Scroll conversation (1 line) |
| Mouse wheel | Buffer empty | Scroll conversation (via alternate-scroll → ↑/↓) |
| `PgUp/PgDn` / `Ctrl+↑/↓` | Buffer empty | Scroll conversation (page) |
| `Esc` | Loading | Abort stream |
| `Esc` | Indexing | Abort index |
| `y/a/n` | Approval | Approve once / approve all / deny |

### Mouse / Wheel Support
The TUI runs in the alternate screen buffer, which has no native scrollback. To make the
**wheel scroll like `less`/`vim`/`htop`**, `enterAlternateScreen()` enables xterm
**alternate-scroll mode** (`\x1b[?1007h`) and deliberately does **not** enable mouse
tracking:
- With `?1007h`, Windows Terminal / xterm translate wheel-up/down into ↑/↓ arrow keys.
- The keyboard handler already scrolls the conversation on ↑/↓ (when the composer is empty
  or the agent is working), so the wheel scrolls the in-app viewport with no extra code.
- Mouse tracking (`?1000h`/`?1006h`) is intentionally **off**: it would capture the wheel as
  SGR button events and break native wheel scrolling. The trade-off is that click-to-select
  on overlays is disabled — every overlay is keyboard-navigable instead.
- `leaveAlternateScreen()` restores with `\x1b[?1007l`.

> A dormant SGR parser (`handleMouseSequence` in `App.tsx`) reads raw stdin via Ink's
> `internal_eventEmitter` (bypassing `parseKeypress`, which strips the leading ESC). It only
> fires if mouse tracking is re-enabled, and is the path to use if click support is restored.

---

## Animation & Motion System

**Location:** `packages/tui/src/motion/`

### Tick Engine (`useTick.ts`)
```typescript
// Custom hook — respects AGENCY_TUI_ANIMATIONS=0 disable flag
useTick(active: boolean, intervalMs: number): number
// Returns incrementing frame counter
// Default intervals: status(90ms), splash(50ms), progress(100ms), activity(80ms)
```

### Design System (`design-system.ts`)
The **motion identity** — the single source of truth for every animated surface. Stance: a
*calm intelligent execution runtime*, not a flashy hacker terminal. Every primitive is
single-cell and ConPTY / Windows-Terminal safe; generic clichés (braille "dots" spinner,
Matrix rain, DNA helix) are deliberately absent, and nothing here is dead — unused primitives
are removed, not parked.

**Spinners / motion**

| Primitive | Description |
|-----------|-------------|
| `AGENCY_SPINNER` | Signature orbiting **arc** spinner `◜◠◝◞◡◟` (NOT braille dots). The one canonical spinner. |
| `SPINNER_DOTS` | Deprecated alias of `AGENCY_SPINNER` (kept so old imports stay in sync). |
| `SPINNER_BLOCKS` | Heavier block-braille pulse `⣾⣽⣻⢿⡿⣟⣯⣷` — the tool-activity "wave". |
| `scanPosition(width, tick, speed)` | Ping-pong scanning position across a width. |
| `pulseDots(tick)` | Cycling `"·"` trail used after the activity label. |
| `energyBar(width, tick)` | `"░▒▓█"` gradient sweep — GoalRunner progress. |
| `gradientChar(ratio)` | `"░▒▓█"` mapped to a clamped 0.0–1.0 ratio. |
| `scanBar(width, tick, headWidth)` | Canonical indeterminate progress: bright head + gradient tail on a dim track (IndexProgress). |
| `accentDivider(width, tick)` | Scanning diamond divider `◆◇·─`. |

**Icon vocabulary** (two purpose-distinct families — see *Typography*)

| Set | Glyphs | Meaning |
|-----|--------|---------|
| `LIFECYCLE_GLYPHS` | pending `◇` · active `◈` · done `◆` · error `✕` | step / agent life-cycle state |
| `SEVERITY_GLYPHS` | info `·` · debug `◦` · adaptation `→` · warning `▲` · error `✗` · critical `✕` | log / event / result severity |

> Warning uses `▲` (single cell) rather than `⚠`, which renders double-width on many Windows
> terminals. The two glyph families never overlap responsibility: lifecycle = "where is this
> step in its life", severity = "how did it land".

### Text Animation (`text.ts`)
- `SPINNER_FRAMES` — re-exported alias of `AGENCY_SPINNER` (`◜◠◝◞◡◟`), so exactly one spinner array exists codebase-wide
- `frameAt(frames, tick)` — cyclic frame access
- `typewriterVisible(text, tick, charsPerTick)` — progressive character reveal
- `shimmerIndex(length, tick)` — cycling highlight position
- `routingPhase(tick)` — cycling routing status text

### AnimatedText Components (`AnimatedText.tsx`)
| Component | Effect |
|-----------|--------|
| `ShimmerText` | Single sliding accent character across text |
| `TypewriterText` | Progressive reveal with blinking cursor |
| `SpinnerText` | `<spinner> label` format |
| `BlinkCursor` | Static `▌` (avoids ANSI blink glitches on Windows) |
| `WaveText` | 3-char highlight window flowing across text |

### Terminal Feedback
- `terminalBell()` — sends `\u0007` only if `AGENCY_TUI_SOUND=1`

---

## Component Catalog

### Core Input Components

#### `ComposerBlock.tsx`
Orchestrates the input stack in a bordered container:
```
┌─────────────────────────────────┐
│ [agent] ▸ typing...             │ ← PromptComposer
├─────────────────────────────────┤
│ /help  /new  /connect  ...      │ ← SlashMenu (when `/` typed)
│ @fil   @file.ts @src/           │ ← AtPicker (when `@` typed)
└─────────────────────────────────┘
```

#### `PromptComposer.tsx`
- Text input box with `❯` cursor
- Mode label badge (Agent/Plan/Debug/Ask)
- Placeholder hints when empty
- Character buffer via `setBuffer`

#### `SlashMenu.tsx`
- `/` command autocomplete
- 6 visible items, sliding window
- Icons: `⚡ immediate` `⏳ async` `⚙ config`
- Filters: `filterSlashMenu(query)` → ranked by relevance

#### `AtPicker.tsx`
- `@` file reference autocomplete
- 6 visible items, sliding window
- File-type icons: `📁 dir` `📄 ts` `📝 md` `🐍 py`
- Uses `fuzzySearchFiles(project, query)` from core

---

### Conversation Components

#### `Conversation.tsx` (memoized)
Virtual-line scrolling message list:
- `calculateFormattedLines()` — converts messages to fixed-height `FormattedLine[]`
- `scrollOffset` windows into the line array
- Auto-scroll to bottom on new messages
- User scrolls up → `userHasScrolledUpRef` holds position
- Message types: user, assistant (with chips/suggestions), system (with icons), structured cards
- Runtime cards: `ReplaceMethodBody`, `InsertFunction`, `DeleteNode`, diff blocks

#### `SystemNotice.tsx`
Formats system messages with context-aware icons:
- `[Harness]` → ⚙ gear icon
- `[Subagent]` → 🤖 robot icon
- `[Thinking]` → 💭 thought bubble
- `[Explore]` → 🔍 magnifying glass
- Error messages → ✗ cross mark
- Success messages → ✓ check mark

#### `EmptyChat.tsx`
Dashboard panel shown when conversation is empty:
- ASCII logo
- Quick command hints
- System context summary (project, model, skills)
- Responsive layout

#### `RouteChips.tsx` **[DEAD — always returns null]**
Hidden per user request. Route chips now rendered inline via `Chip` component.

#### `Chip.tsx`
Single `<label>:<value>` display pair for routing metadata.

---

### Overlays (Modal Components)

All overlays follow a shared pattern:
1. Full-screen centering (flexGrow + alignItems/justifyContent center)
2. Rounded accent border container
3. Title header with close hint
4. Interactive list/content
5. Footer with navigation hints

| Overlay | Key | Size | Description |
|---------|-----|------|-------------|
| `HelpOverlay` | `?` key | Adaptive (1 or 2 col) | Lists slash commands, key bindings, modes |
| `ConnectOverlay` | `/connect` | 4-phase | Manage API keys: list providers → select → input key → confirm/disconnect |
| `ModelsOverlay` | `/models` | 2-phase | Browse models: select provider → select model, history of frequent models |
| `SkillsPicker` | `/skills` | Scrolling list | Browse/inject skills into prompt with icons |
| `PluginsOverlay` | `/plugins` | Read-only browser | View installed skill packs from skills-root |
| `ReviewMenu` | `/review` | 4 actions | Select code review target: commit/branch/PR/CI |
| `StatusDashboard` | `/status` | Multi-section | System telemetry: providers, skills, MCP, routing, session stats |
| `VariantOverlay` | `/variant` | Variant picker | Select model thinking budget variant |
| `McpOverlay` | `/mcp` | Full CRUD | Manage MCP servers: add (4-step wizard), edit env, delete |
| `SubagentsOverlay` | `/agents` | Dispatch log | Browse subagent dispatch history + log viewer |
| `SessionPicker` | `/sessions` | Session list | Resume/delete previous sessions |
| `WelcomeScreen` | `/project` | Project picker | Switch between recent projects |

---

### Progressive Display Components

#### `CognitionPanel.tsx`
- Runtime thought log from EventBus
- 3 disclosure levels: default (1-2 thoughts), advanced (5), expert (all)
- Color-coded by severity: info/adaptation/warning/critical
- Timestamp + source + message format

#### `StatusBar.tsx`
Bottom bar in Shell chrome:
```
[agent mode]                    ◉ routing          claude-3-5   45%
```

- Left: Agent mode label + activity phase label
- Center: Spinner when loading + phase text
- Right: Model name + context usage percentage
- Compact mode for narrow terminals

#### `ToolActivity.tsx`
Loading indicator between conversation and input:
- `SPINNER_BLOCKS` wave + phase label ("Routing...", "Analyzing...", "Writing...")
- **Holographic light-sweep shimmer**: a soft band glides left→right across the label
  (grouped runs: base `text` → near `accent` → peak `highlight`). The base stays steady —
  no global dim/brighten — so there is zero on/off flicker.
- `pulseDots` trail, elapsed time counter, token count, `esc cancel` hint

#### `GoalRunner.tsx`
Multi-step autonomous goal display:
- Progress bar (energy bar animation)
- Scrollable task list with status icons (pending/running/done)
- Elapsed time
- Max 4 visible steps, sliding window for more

#### `IndexProgressPanel.tsx`
Workspace index scan indicator:
- Phase: "Scanning...", "Indexing..."
- `scanBar()` indeterminate progress + `AGENCY_SPINNER` (shared primitives — no bespoke spinner)
- File count progress + elapsed time

---

### Special Components

#### `Splash.tsx` (384 lines)
Cyberpunk BIOS boot screen:
- Staged animation sequences (4 stages)
- `GlowingLogo` pixel-art "AGENCYCLI" display
- `AGENCY_SPINNER` arc + scanning dividers (no Matrix-rain cliché)
- Version + project + skills path display
- Auto-advances to welcome phase

#### `WelcomeMenu.tsx`
Post-splash 3-option selection:
- "New Worktree" — create fresh session
- "Resume Session" — open session picker
- "Quit" — exit application
- Mouse-clickable cards with hover highlight
- Reuses `ScanningDivider` from Splash

#### `GlowingLogo.tsx`
Pixel-art "AGENCYCLI" logo:
- 7×6 pixel grid (full) / 5×4 (compact)
- 3-layer neon animation (outer glow, inner fill, highlight)
- Cycles through 4 corner styles
- Responsive: switches to compact on narrow terminals

---

### Data Visualization Components

#### `DataView.tsx`
Reusable data display primitives:
- `DataTable` — columnar data with headers
- `CodeBlock` — syntax-highlighted code blocks
- `DiffBlock` — unified diff with +/- markers
- `ProgressBar` — horizontal progress bar

---

### Dead/Stale Components

| Component | Status |
|-----------|--------|
| `RouteChips.tsx` | **Always returns null** — hidden per feature flag |
| `MessageRow.tsx` | Legacy — not imported anywhere |
| `UserLine.tsx` | Legacy — not imported anywhere |
| `AssistantBlock.tsx` | Legacy — not imported anywhere |

---

## Screens System

**Location:** `packages/tui/src/screens/`

`ScreenId` type: `"home" | "chat" | "skills" | "taskRunner" | "approval" | "graph"`

| Screen | Status |
|--------|--------|
| `Approval.tsx` | **Active** — y/n approval prompt overlay |
| `Sidebar.tsx` | **Scaffold** — layout component for screen tabs, not wired to App |
| `Home.tsx` | **Scaffold** — placeholder, not used |
| `TaskRunner.tsx` | **Scaffold** — placeholder, not used |
| `Graph.tsx` | **Scaffold** — placeholder, not used |
| `Skills.tsx` | **Scaffold** — placeholder, not used |

The screens-as-tabs concept was scaffolded but abandoned in favor of the overlay+single-view model used in App.tsx.

---

## Slash Command System

**Location:** `packages/tui/src/slash/commands.ts` (592 lines)

`executeSlash(input, context)` → `SlashResult` with flags that App.tsx processes.

| Command | Action |
|---------|--------|
| `/help` | Open HelpOverlay |
| `/new` | Create new session + clear route cache |
| `/connect` | Open ConnectOverlay (API key management) |
| `/models` | Open ModelsOverlay (model picker) |
| `/skills` | Open SkillsPicker (skill browser) |
| `/plugin` | Open PluginsOverlay (skill pack viewer) |
| `/review [type]` | Open ReviewMenu or inject review prompt |
| `/status` | Open StatusDashboard (system telemetry) |
| `/mcp` | Open McpOverlay (MCP server config) |
| `/variant [value]` | Open VariantOverlay or set directly |
| `/theme [id]` | Switch theme (agency/daylight) |
| `/sessions` | Open SessionPicker (resume/delete) |
| `/project` | Open project picker |
| `/goal <task>` | Launch multi-step autonomous task |
| `/schedule every X <task>` | Create recurring cron schedule |
| `/agents` | Open SubagentsOverlay (dispatch history) |
| `/route [feedback <intent>]` | Open RouteOverlay (record intent routing feedback) |
| `/dashboard` (alias `/memory`) | Open browser knowledge & memory dashboard |
| `/index` | Run workspace index |
| `/compact [dry]` | Compact conversation context |
| `/export` | Export session to markdown |
| `/exit` | Quit application |

---

## State Architecture (App.tsx)

### State Variables (25+ useStates)
```
Phase Management:
  phase: "splash"|"welcome"|"main"
  themeId: "agency"|"daylight"

Session + Messages:
  session: AgencySession
  buffer: string (composer text)
  loading: boolean
  scrollOffset: number

Queue:
  promptQueueRef: string[]
  processingRef: boolean

Routing + Model:
  lastRouteProvider: string|null
  activeModelName: string|null
  agencyConfig: AgencyConfig

Agent Mode:
  agentMode: "agent"|"plan"|"debug"|"ask"

Goal Runner:
  goalActive, goalTask, goalSteps[], goalCurrentStep, goalStartMs

Indexing:
  indexing: boolean
  indexProgress: IndexProgress|null

Activity Tracking:
  activityPhase: ActivityPhase
  tokenCount: number
  elapsedMs: number

Approval:
  pendingApproval: PendingApproval|null

Overlay States (single `overlays: OverlayStates` object, 13 keys):
  help, connect, models, skills, review, status, plugins,
  variant, mcp, agents, resume, project, route
  — toggled via setOverlayOpen(key, bool) / closeAllOverlays();
    keyboard routing lives in hooks/useKeyboardHandlers.ts

Context:
  contextUsage { percent, estimatedTokens, contextWindow }
  thoughts: RuntimeThoughtEvent[]
```

### Derived State (useMemos)
- `composerHeight` — calculated from buffer + loading state
- `fixedHeight` — header + dividers + composer + footer + overlays
- `conversationHeight` — `rows - fixedHeight`
- `virtualLinesCount` — from `calculateFormattedLines()`
- `slashSuggestions`, `atSuggestions` — autocomplete lists
- `displayModelName` — fallback chain: activeModel → config
- `providerStatuses` — 6 providers with configured status
- `thinkingLabel` — resolved variant name

### Context Providers
| Provider | Purpose |
|----------|---------|
| `TerminalLayoutProvider` | Terminal width/height measurement |
| `DisclosureProvider` | Progressive disclosure levels (3 tiers) |
| `HeartbeatProvider` | Idle detection (3s silence budget) |

---

## Session System

**Location:** `packages/tui/src/sessions/`

### Store (`store.ts`)
- JSON files in `.agency/sessions/sess-*.json`
- CRUD: `createSession()`, `loadSession()`, `saveSession()`, `deleteSession()`
- `listSessionSummaries()` — lightweight metadata for session picker
- `loadLatestSession()` — auto-creates fresh if none exist
- Export: markdown format

### Schema
```typescript
interface AgencySession {
  id: string;
  createdAt: number;
  updatedAt: number;
  project: string;
  messages: SessionMessage[];
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  presentation?: {
    chips?: Chip[];
    suggestions?: string[];
    cacheHint?: "cached" | undefined;
  };
  streaming?: boolean;
  timestamp: number;
}
```

### Projects (`projects.ts`)
- `loadProjects()` — recent projects from `.agency/projects.json`
- `touchProject(path)` — register project access
- Project validation via `package.json` existence

---

## @-Reference System

**Location:** `packages/tui/src/at/`

### Flow
1. `getAtQuery(buffer)` — detects `@` trigger in input
2. `fuzzySearchFiles(project, query, 30)` — from core workspace indexer
3. `AtPicker.tsx` renders results in sliding window below composer
4. User selection → injects filename into prompt buffer

### Fuzzy Search
- Uses `.agency/index.json` as file source
- Fuzzy matching via text-matching algorithm
- Max 30 results
- Sorted by relevance

---

## File Edit System

### Parse → Approve → Write Pipeline

```
LLM Response
    │
    ▼
parseFileEditSuggestions(text, projectRoot)
    │
    ├─ SEARCH/REPLACE pattern → FileEditSuggestion
    ├─ NEW FILE pattern        → FileEditSuggestion
    └─ DELETE FILE pattern     → FileEditSuggestion
    │
    ▼
pendingFileEditsRef queue
    │
    ▼
Approval Prompt (y/n in TUI)
    ├─ "y" → writeFileSync + mkdirSync
    │         └─→ buildIndex + writeIndex (re-index workspace)
    └─ "n" → skip, move to next edit
```

### User Approval UX
- When file edits detected, transitions to Approval phase
- Shows: file path, operation type, preview of changes
- `y` approves single edit → moves to next in queue
- `n` denies → skips edit
- After all edits processed, returns to conversation

---

## Rendering Pipeline

```
1. enterAlternateScreen()
   └─ \x1b[?1049h (alternate buffer)
   └─ \x1b[?1007h (alternate-scroll mode → wheel becomes ↑/↓ arrows)
   └─ Hide cursor (\x1b[?25l), no-autowrap (\x1b[?7l)
   └─ Batch stdout/stderr writes (synchronized output \x1b[?2026h/l)

2. Ink's render(<ProviderChain><App/></ProviderChain>, { stdout })

3. React reconciler outputs ANSI to terminal:
   └─ Box → flexbox layout via Yoga
   └─ Text → colored ANSI text
   └─ useInput → raw stdin handler

4. TerminalLayoutProvider measures dimensions
5. App renders phase-appropriate view
6. Conversation virtual-scrolls: FormattedLine[] + scrollOffset
7. leaveAlternateScreen() on exit
   └─ Flush write queues
   └─ Restore stdout
   └─ \x1b[?1049l (exit alternate buffer)
```

---

## Visual Design Principles

### Color System
- **Dark-first**: Both themes are dark (GitHub dark, zinc near-black)
- **Accent color**: Used for borders, highlights, selection, links
- **Semantic colors**: Success (green), Warning (yellow), Danger (red)
- **Muted text**: Secondary information, hints, dimmed states

### Spacing
- `paddingX={2}` standard for overlay containers
- `gap={1}` between list items
- Fixed-width layout components respect terminal dimensions

### Typography
- Single-char UI primitives: `❯` cursor, `▸` selected item, `·` separator
- Icons per file type: `📁` dir, `📄` file, `🐍` Python, `📝` markdown
- **Lifecycle icons** (`LIFECYCLE_GLYPHS`): pending `◇`, active `◈`, done `◆`, error `✕`
- **Severity icons** (`SEVERITY_GLYPHS`): info `·`, debug `◦`, adaptation `→`, warning `▲`, error `✗`, critical `✕`
- Box-drawing chars: `┌─┐│└─┘├─┤` for borders (Ink's `borderStyle="round"`)

### Progressive Disclosure
3 tiers via `DisclosureProvider`:
1. **Default**: Minimal — 1-2 thought events, basic info
2. **Advanced**: Moderate — 5 thoughts, file details
3. **Expert**: Full — all thoughts, verbose logs, debug info

Cycled via `Ctrl+D` or `/disclosure` slash command.
