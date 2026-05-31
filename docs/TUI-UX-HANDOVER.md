# TUI/TUX Handover — Motion Identity, Icon System & Native Wheel Scroll

> **Date:** 2026-05-30
> **Scope:** `packages/tui` (motion/design-system, loading UX, icon vocabulary, terminal scroll) + docs
> **Status:** ✅ typecheck clean · `dist` built · **25 test files / 103 tests pass**
> **Audience:** the next session picking up TUI/UX work — read §2 (decisions) and §7 (gotchas) before touching scroll or motion.

---

## 1. What this session delivered

Five threads, all landed and verified:

1. **Motion identity hardened** — `motion/design-system.ts` pruned of cliché/dead primitives; every remaining primitive has a real consumer (single source of truth).
2. **Loading animation reworked** — `ToolActivity` no longer flickers dark↔light; a holographic light-sweep shimmer travels across the label.
3. **Icon/glyph identity** — two purpose-distinct families (`LIFECYCLE_GLYPHS`, `SEVERITY_GLYPHS`) replace scattered raw glyphs; ConPTY-safe.
4. **Native wheel scroll** — switched from in-app SGR mouse tracking to terminal **alternate-scroll mode** (`?1007h`); the wheel now scrolls like `less`/`vim`. Removed the fake in-app scrollbar that was tried first.
5. **Docs synced + dead code removed** — `UI_DESIGN.md` / `PACKAGES.md` updated; ~264-line dormant mouse handler deleted from `App.tsx`.

---

## 2. Key decisions & rationale (READ THIS FIRST)

### 2.1 Wheel scroll: alternate-scroll mode, NOT mouse tracking
- The TUI runs in the **alternate screen buffer** (`?1049h`), which has **no native scrollback** — so Windows Terminal's own scrollbar/wheel physically cannot scroll history. This is the same as `vim`/`htop`/`less`. A *true* native scrollbar would require abandoning the alt-screen pinned-layout model (a full rewrite, e.g. Ink `<Static>`); **explicitly out of scope / rejected** as "phá codebase".
- **Root cause the wheel never worked before:** the app enabled SGR mouse tracking (`?1000h?1006h`) and tried to parse wheel events via Ink's `useInput`. But Ink's `use-input.js` runs every chunk through `parseKeypress` and **strips the leading ESC** (`input.slice(1)`), so an SGR report `\x1b[<64;x;yM` arrived as `[<64;x;yM` and the `startsWith("\x1b[<")` guard never matched. ConPTY can also split one report across chunks.
- **The fix:** `enterAlternateScreen()` now enables **alternate-scroll mode** (`\x1b[?1007h`) and does **NOT** enable mouse tracking. WT/xterm then translate wheel-up/down into ↑/↓ arrow keys, which the keyboard handler already scrolls on (when composer is empty or agent is working). Zero JS mouse code needed. `leaveAlternateScreen()` restores with `?1007l`.
- **Trade-off accepted:** click-to-select on overlays is disabled (mouse tracking off). All overlays are keyboard-navigable. To restore clicks, see §6.

### 2.2 Loading shimmer: no global dim/brighten
- The earlier "breathing glow" (`breatheStep` toggling `dimColor`/`bold` on the spinner) read as an on/off **flicker** ("nháy tối xong sáng") — user rejected it.
- Replaced with `buildShimmerRuns()` in `ToolActivity.tsx`: a soft band (peak `highlight` → near `accent` → base `text`) sweeps left→right across the label using grouped runs. **Base color stays steady** → only a localized highlight moves → no flicker, wider coverage.
- `breatheAlpha` / `breatheStep` were therefore removed entirely (no remaining consumer = dead code).

### 2.3 No-dead-code principle for the motion identity
- `motion/design-system.ts` is treated as a *tight identity*: if a primitive loses its last consumer, it is **removed, not parked**. Pruned this session: `matrixRow` (Matrix-rain cliché), `helixFrame` (DNA cliché), `particleAt`, `particleTrail`, `waveOffset`, `animatedBorderChars`, `STATUS_GLYPHS`, plus `breatheAlpha`/`breatheStep`.
- Clichés are deliberately gone — the stance is a **calm execution runtime**, not a flashy hacker terminal.

### 2.4 Fake scrollbar — tried then removed
- A rendered vertical `Scrollbar.tsx` (thumb `█` on dim `│` track, geometry via `scrollThumb()`) was added then **removed** at the user's request: ugly, not compact, and didn't fix the wheel. `Conversation.tsx` is back to its original viewport render. Don't re-add a fake bar — pursue real scroll (already solved via §2.1) instead.

---

## 3. Files changed this session

### Source
| File | Change |
|------|--------|
| `packages/tui/src/motion/design-system.ts` | Rewrote into the tight motion identity (see §4). Pruned 8 primitives, added `scanBar`, `SEVERITY_GLYPHS`. Now ~152 lines. |
| `packages/tui/src/components/ToolActivity.tsx` | Added `buildShimmerRuns()` light-sweep; removed breathing glow; uses `SPINNER_BLOCKS` + `pulseDots`. |
| `packages/tui/src/components/ExecutionPanel.tsx` | Severity icons → `SEVERITY_GLYPHS`; phase nodes ○/✓/→ → `LIFECYCLE_GLYPHS`. |
| `packages/tui/src/components/LogCollapse.tsx` | Severity icons → `SEVERITY_GLYPHS`. |
| `packages/tui/src/components/IndexProgress.tsx` | Removed local `activityBar` + rogue `"▖▘▝▗"` spinner → `scanBar()` + `AGENCY_SPINNER`. |
| `packages/tui/src/terminal/screen.ts` | `enterAlternateScreen`: `?1007h` (alt-scroll), removed `?1000h?1006h`. `leaveAlternateScreen`: `?1007l`, removed `?1000l?1006l`. |
| `packages/tui/src/App.tsx` | **Removed ~264-line dormant mouse handler** (`mouseStateRef` + update effect + `handleMouseSequence` + `internal_eventEmitter` effect). Removed `useStdin` import. Left a 6-line explanatory comment. |
| `packages/tui/src/components/Conversation.tsx` | Reverted fake-scrollbar wiring back to original viewport render. |

### Deleted
- `packages/tui/src/components/Scrollbar.tsx` (fake scrollbar)
- `scrollThumb()` from `packages/tui/src/layout/terminal-layout.ts`

### Tests
| File | Change |
|------|--------|
| `packages/tui/src/motion/__tests__/design-system.test.ts` | Added `SEVERITY_GLYPHS` (single-cell, no `⚠`), `scanBar`/`energyBar` width, `gradientChar` clamp. Removed breathing tests. |
| `packages/tui/src/__tests__/runtime-cards.test.tsx` | **NEW** — render smoke for `RuntimeCard`, `PatchCard`, `LogCollapse`, `ExecutionPanel` (verify lifecycle/severity glyphs). |
| `packages/tui/src/layout/__tests__/terminal-layout.test.ts` | Removed `scrollThumb` tests (helper deleted). |

### Docs
- `docs/UI_DESIGN.md` — rewrote Design System table, SPINNER_FRAMES (arc not braille), Mouse/Wheel Support, key bindings, ToolActivity/IndexProgress/Splash, Typography, rendering pipeline.
- `docs/PACKAGES.md` — `design-system.ts` description (dropped stale "166-line").

---

## 4. Motion identity reference (`motion/design-system.ts`)

Current exports — **this is the single source of truth; do not redefine spinners/glyphs elsewhere:**

**Spinners / motion**
- `AGENCY_SPINNER` = `◜◠◝◞◡◟` — signature orbiting arc (NOT braille dots). The canonical spinner.
- `SPINNER_DOTS` — deprecated alias of `AGENCY_SPINNER`.
- `SPINNER_BLOCKS` = `⣾⣽⣻⢿⡿⣟⣯⣷` — block pulse (tool-activity wave).
- `scanPosition(width, tick, speed=1)` — ping-pong index (used by `scanBar`, `accentDivider`).
- `pulseDots(tick)` — cycling `·` trail.
- `energyBar(width, tick)` — `░▒▓█` gradient sweep (GoalRunner).
- `gradientChar(ratio)` — `░▒▓█` for clamped 0..1.
- `scanBar(width, tick, headWidth=3)` — bright head + gradient tail on dim track (IndexProgress).
- `accentDivider(width, tick)` — scanning diamond `◆◇·─`.

**Icon vocabulary (two families, never overlapping responsibility)**
- `LIFECYCLE_GLYPHS` = `{ pending: "◇", active: "◈", done: "◆", error: "✕" }` — step/agent life-cycle.
- `SEVERITY_GLYPHS` = `{ info: "·", debug: "◦", adaptation: "→", warning: "▲", error: "✗", critical: "✕" }` — log/event/result severity.

> Warning is `▲` not `⚠` (the latter renders double-width on many Windows terminals). `text.ts` re-exports `SPINNER_FRAMES` as an alias of `AGENCY_SPINNER` — one spinner array codebase-wide.

Consumers (keep these in sync if you touch the identity): `ToolActivity`, `IndexProgress`, `ExecutionPanel`, `LogCollapse`, `SubagentPanel`, `SubagentStepRow`, `WorkerProgress`, `GoalRunner`, `Splash`, `TraceTelemetry`.

---

## 5. How to verify

```bash
cd packages/tui
npx tsc -p tsconfig.json --noEmit   # typecheck (0 errors)
npx vitest run                      # 25 files / 103 tests
npx tsc -p tsconfig.json            # build dist (REQUIRED to see changes in the running app)
```

**Critical:** the CLI runs the **built `dist/`** (`@agency/tui` `main: ./dist/index.js`). After any source change you must rebuild AND restart `acg` — the running process holds the old `dist`. Tests run against `src` via vitest, so green tests ≠ updated app.

Manual wheel check: `pnpm acg` → put cursor in conversation, empty composer, scroll wheel → should scroll 1 line per notch (via ↑/↓ translation). If it doesn't, alternate-scroll may be disabled in Windows Terminal settings.

---

## 6. Known limitations / not done

1. **Overlay click-to-select is disabled** (mouse tracking off for wheel). To restore: in `screen.ts` re-add `\x1b[?1000h\x1b[?1006h` (enter) and `\x1b[?1000l\x1b[?1006l` (leave), then reinstate an SGR parser. The dormant handler was deleted but the pattern is documented inline in `App.tsx` and recoverable from git history. **Caveat:** you cannot have both native wheel (alt-scroll) and mouse tracking — tracking captures the wheel as button events.
2. **No true native scrollbar** — inherent to the alt-screen model (see §2.1). Only a full `<Static>`-based rewrite would change this.
3. **Wheel scroll is gated** — only fires when the composer buffer is empty or the agent is loading (same gate as ↑/↓ in `useKeyboardHandlers.ts`). When typing, the wheel won't scroll.
4. **`SubagentStepRow.formatTechnicalSubLine`** still uses raw inline status glyphs (✓→✕●~) for highlighting status *words* in text — intentionally left (it's a text parser, different context; refactor is higher-risk than reward).
5. **Handoff doc lineage** — the older `docs/TUI-UX-HANDOFF.md` was deleted earlier in the repo's history; this file supersedes it.

---

## 7. Gotchas for the next session

- **Ink strips ESC** from sequences it can't name (`use-input.js`: `input.slice(1)`). Never rely on `useInput` receiving raw `\x1b…` sequences. For raw bytes, subscribe to `useStdin().internal_eventEmitter` `"input"` (the unmodified chunk) — but mind ConPTY chunk-splitting (buffer + reassemble).
- **Scrollbar flicker history** — `Conversation.tsx` content is formatted to `innerWidth = contentWidth(cols) = cols - 2`, reserving 2 right-margin columns. Output reaching the **last terminal column** toggles WT's native scrollbar, shrinking `cols` by 1 → re-render → flicker loop. Keep any new right-edge element inside the slack (≤ `cols - 1`). See `layout/terminal-layout.ts` header comment.
- **dist vs src** — see §5. Most "my change didn't take effect" reports are a missing rebuild/restart.
- **`noUnusedLocals: true`** (in `tsconfig.base.json`) — removing a consumer can cascade into unused-import errors. The build is the canonical check.
- **Single source of truth** — there is a test (`design-system.test.ts`) asserting `SPINNER_DOTS === AGENCY_SPINNER === SPINNER_FRAMES` and that the spinner is not braille. Don't add a second spinner array.

---

## 8. How to extend

- **Add a motion primitive:** add to `motion/design-system.ts`, wire it into at least one component in the same change (no dead code), and add a determinism/width test in `design-system.test.ts`.
- **Add a severity/lifecycle icon:** extend the relevant glyph map only; keep single-cell + ConPTY-safe (avoid emoji variation-selector chars). Update the `design-system.test.ts` expectation and `UI_DESIGN.md` Typography section.
- **Touch loading UX:** keep the "no global dim" rule — motion should be localized movement, not brightness pulsing.

---

## 9. Repo / git state

- Branch `master` has **no commits yet** — the entire project is staged (working-tree initial state). This session's changes are **uncommitted**.
- Suggested commit scope when ready: motion identity + icon system + loading shimmer + alternate-scroll wheel + dead-code removal + docs. (Co-author trailer per repo convention.)
