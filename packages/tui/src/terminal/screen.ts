/** Alternate screen buffer — keeps scrollback of the main shell session intact. */
import { appendFileSync, mkdirSync } from "node:fs";

let active = false;
let originalWrite: (typeof process.stdout.write) | null = null;
let originalErrWrite: (typeof process.stderr.write) | null = null;

interface WriteJob {
  chunk: string;
  cb?: () => void;
}

let stdoutQueue: WriteJob[] = [];
let stdoutScheduled = false;
let stderrQueue: WriteJob[] = [];
let stderrScheduled = false;

// 1. Precise Loop Lag Monitor & Survival Hysteresis Governance
let lastTickTime = typeof performance !== "undefined" ? performance.now() : Date.now();
let loopLag = 0;
export type DegradationTier = 0 | 1 | 2 | 3;
let activeTier: DegradationTier = 0;
let lastTransitionTime = typeof performance !== "undefined" ? performance.now() : Date.now();
let highLagCounter = 0;
let lowLagCounter = 0;

const lagInterval = setInterval(() => {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  loopLag = Math.max(0, now - lastTickTime - 50);
  lastTickTime = now;

  if (typeof process !== "undefined" && process.env.VITEST) {
    activeTier = 0;
    return;
  }

  // Hysteresis counters
  if (loopLag > 200) {
    highLagCounter++;
  } else {
    highLagCounter = 0;
  }

  if (loopLag < 80) {
    lowLagCounter++;
  } else {
    lowLagCounter = 0;
  }

  const elapsedSinceTransition = now - lastTransitionTime;

  if (activeTier === 3) {
    // EXIT survival: lag < 80ms sustained for 5s (100 ticks at 50ms) AND cooldown of 3000ms is met
    if (loopLag < 80 && lowLagCounter >= 100 && elapsedSinceTransition > 3000) {
      activeTier = 0;
      lastTransitionTime = now;
      lowLagCounter = 0;
    }
  } else {
    // ENTER survival: lag > 200ms sustained for 2s (40 ticks at 50ms) AND cooldown of 3000ms is met
    if (loopLag > 200 && highLagCounter >= 40 && elapsedSinceTransition > 3000) {
      activeTier = 3;
      lastTransitionTime = now;
      highLagCounter = 0;
    }
  }
}, 50);

if (lagInterval && typeof lagInterval.unref === "function") {
  lagInterval.unref();
}

export function getLoopLag(): number {
  if (typeof process !== "undefined" && process.env.VITEST) {
    return 0;
  }
  return loopLag;
}

let lastLagUnder50Time = typeof performance !== "undefined" ? performance.now() : Date.now();
let currentTier: DegradationTier = 0;

export function getDegradationTier(messagesLength: number = 0): DegradationTier {
  if (tuiPhase === "splash" || tuiPhase === "welcome") {
    if (loopLag > 2000) {
      return 3;
    }
    return 0;
  }

  if (messagesLength > 10000) {
    return 3;
  }

  if (typeof process !== "undefined" && process.env.VITEST) {
    return 0;
  }

  // Tier 3 is strictly governed by the hysteresis activeTier
  if (activeTier === 3) {
    return 3;
  }

  const queueDepth = stdoutQueue.length + stderrQueue.length;
  // Overwhelming buffer boundaries also trigger transition locks safely
  if (queueDepth > 1000 || messagesLength > 10000) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastTransitionTime > 3000) {
      activeTier = 3;
      lastTransitionTime = now;
      return 3;
    }
  }

  const lag = getLoopLag();
  let targetTier: DegradationTier = 0;
  if (lag > 100 || queueDepth > 500 || messagesLength > 1000) {
    targetTier = 2;
  } else if (lag > 50 || queueDepth > 100 || messagesLength > 500) {
    targetTier = 1;
  }

  // Smooth intermediate tier decay
  if (targetTier > currentTier) {
    currentTier = targetTier;
  } else if (targetTier < currentTier) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastLagUnder50Time > 2000) {
      currentTier = targetTier;
      lastLagUnder50Time = now;
    }
  }

  return currentTier;
}

export function forceLevel3SurvivalMode(): void {
  activeTier = 3;
  lastTransitionTime = typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function writeRawStdout(chunk: string): void {
  if (originalWrite) {
    originalWrite.call(process.stdout, chunk);
  } else {
    process.stdout.write(chunk);
  }
}

let tuiPhase: "splash" | "welcome" | "main" = (typeof process !== "undefined" && process.env.VITEST) ? "main" : "splash";

export function setTuiPhase(phase: "splash" | "welcome" | "main"): void {
  tuiPhase = phase;
}

export function getTuiPhase(): "splash" | "welcome" | "main" {
  return tuiPhase;
}

// 2. Terminal Capability & Pressure-Based Adaptive Flush Interval with ConPTY Backpressure
export function getAdaptiveFlushInterval(messagesLength: number = 0): number {
  if (tuiPhase === "splash" || tuiPhase === "welcome") {
    const tier = getDegradationTier(messagesLength);
    if (tier === 3) {
      return 500;
    }
    return 16;
  }

  const tier = getDegradationTier(messagesLength);
  if (tier === 3) {
    return 500;
  }
  if (tier === 2) {
    return 50;
  }

  const isSSH = !!(process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION);
  const isConPTY = process.platform === "win32"; // Windows uses ConPTY internally

  let baseInterval = 16;
  if (isSSH) {
    baseInterval = 150; // Save bandwidth over SSH
  } else if (isConPTY) {
    baseInterval = 50;  // Reduce ConPTY rendering overhead
  }

  // ConPTY Backpressure Governance
  const queueDepth = stdoutQueue.length + stderrQueue.length;
  if (queueDepth > 600) {
    return Math.max(baseInterval * 3, 150); // Progressive cap
  } else if (queueDepth > 300) {
    return Math.max(baseInterval * 2, 100); // Progressive scale
  }

  const lag = getLoopLag();
  if (lag > 30) {
    return Math.max(baseInterval, 50);  // Medium pressure
  }
  return baseInterval;
}

let lastStdoutFlushTime = 0;
let stdoutFlushTimeout: NodeJS.Timeout | null = null;
let lastStderrFlushTime = 0;
let stderrFlushTimeout: NodeJS.Timeout | null = null;

function flushStdoutQueue(): void {
  if (stdoutQueue.length === 0) return;
  const jobs = stdoutQueue;
  stdoutQueue = [];
  stdoutScheduled = false;

  let combined = jobs.map((j) => j.chunk).join("");

  if (combined.includes("\x1b[?25h")) combined = combined.replace(/\x1b\[\?25h/g, "");
  if (combined.includes("\x1b[?25l")) combined = combined.replace(/\x1b\[\?25l/g, "");

  if (combined.length > 0 && originalWrite) {
    const syncedFrame = `\x1b[?2026h${combined}\x1b[?2026l`;
    originalWrite.call(process.stdout, syncedFrame, "utf8" as any, () => {
      for (const job of jobs) {
        if (job.cb) job.cb();
      }
    });
  } else {
    for (const job of jobs) {
      if (job.cb) job.cb();
    }
  }
}

function flushStderrQueue(): void {
  if (stderrQueue.length === 0) return;
  const jobs = stderrQueue;
  stderrQueue = [];
  stderrScheduled = false;

  let combined = jobs.map((j) => j.chunk).join("");

  if (combined.includes("\x1b[?25h")) combined = combined.replace(/\x1b\[\?25h/g, "");
  if (combined.includes("\x1b[?25l")) combined = combined.replace(/\x1b\[\?25l/g, "");

  if (combined.length > 0 && originalErrWrite) {
    const syncedFrame = `\x1b[?2026h${combined}\x1b[?2026l`;
    originalErrWrite.call(process.stderr, syncedFrame, "utf8" as any, () => {
      for (const job of jobs) {
        if (job.cb) job.cb();
      }
    });
  } else {
    for (const job of jobs) {
      if (job.cb) job.cb();
    }
  }
}


let lastErrorReport = "";
let lastErrorReportAt = 0;

/**
 * Non-fatal runtime-error sink.
 *
 * A stray async rejection or background error must NOT eject the user to the
 * shell. The old handlers called `cleanup()` + `process.exit(1)` on *any*
 * `unhandledRejection`/`uncaughtException`, which tore down the alternate
 * screen and killed the process — leaving a half-dead TUI frame sitting over a
 * live shell prompt (you could type, but input went to the shell and errored).
 * In an async-heavy runtime (MCP calls, memory writes, aborted fetches, a
 * forgotten `.catch`) a single stray rejection should never do that.
 *
 * Instead we log durably to `.agency/crash.log` and surface a banner via the
 * App's global hook, while STAYING in the alternate screen and keeping the
 * process alive. Identical errors are throttled so a render/async loop can't
 * spam the log or UI.
 */
export function reportRuntimeError(kind: string, err: any): void {
  const summary = err instanceof Error ? err.message : String(err);
  const detail = (err && err.stack) ? err.stack : summary;
  const line = `${kind}: ${detail}`;

  const nowTs = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (line === lastErrorReport && nowTs - lastErrorReportAt < 1000) return;
  lastErrorReport = line;
  lastErrorReportAt = nowTs;

  // 1. Durable crash log (best-effort, never throws, never blocks for long).
  try {
    mkdirSync(".agency", { recursive: true });
    appendFileSync(".agency/crash.log", `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging is best-effort */
  }

  // 2. Surface to the UI without tearing down the alternate screen.
  try {
    const hook = (globalThis as any).onAgencyRuntimeError;
    if (typeof hook === "function") hook(`${kind}: ${summary}`);
  } catch {
    /* never let error reporting throw */
  }
}

let exitListenersRegistered = false;

function registerEmergencyExitListeners(): void {
  if (exitListenersRegistered) return;
  exitListenersRegistered = true;

  const cleanup = () => {
    leaveAlternateScreen();
  };

  process.on("exit", cleanup);

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  // Non-fatal: log + surface a banner, but keep the TUI alive and stay in the
  // alternate screen. See reportRuntimeError. Intentional quits (SIGINT/SIGTERM
  // above, and the normal Ink exit path) still restore the terminal cleanly.
  process.on("uncaughtException", (err) => {
    reportRuntimeError("Uncaught Exception", err);
  });

  process.on("unhandledRejection", (reason: any) => {
    reportRuntimeError("Unhandled Rejection", reason);
  });
}

export function enterAlternateScreen(): void {
  if (!process.stdout.isTTY || active) return;
  registerEmergencyExitListeners();
  // ?1049h alt screen · ?25l hide cursor · ?7l no-autowrap · ?1007h alternate
  // scroll mode. We intentionally do NOT enable mouse tracking (?1000h/?1006h):
  // in the alternate screen, ?1007h makes Windows Terminal / xterm translate the
  // scroll wheel into Up/Down arrow keys (which the app already scrolls on), so
  // the wheel works like it does in less/vim/htop. Mouse tracking would instead
  // capture the wheel as button events and break native wheel scrolling.
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?7l\x1b[?1007h");
  process.stderr.write("\x1b[?25l");
  active = true;

  originalWrite = process.stdout.write;
  process.stdout.write = function (
    chunk: any,
    encoding?: any,
    cb?: any
  ): boolean {
    let str = "";
    if (typeof chunk === "string") {
      str = chunk;
    } else if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
      str = chunk.toString((typeof encoding === "string" ? encoding : "utf8") as any);
    }

    const callback = typeof encoding === "function" ? encoding : cb;
    stdoutQueue.push({ chunk: str, cb: callback });

    if (!stdoutScheduled) {
      stdoutScheduled = true;
      const now = Date.now();
      const elapsed = now - lastStdoutFlushTime;
      const interval = getAdaptiveFlushInterval();
      const useCoalesce = tuiPhase === "splash" || tuiPhase === "welcome";

      if (elapsed >= interval && !useCoalesce) {
        process.nextTick(() => {
          lastStdoutFlushTime = Date.now();
          flushStdoutQueue();
        });
      } else {
        const delay = useCoalesce ? Math.max(8, interval - elapsed) : (interval - elapsed);
        if (stdoutFlushTimeout) clearTimeout(stdoutFlushTimeout);
        stdoutFlushTimeout = setTimeout(() => {
          lastStdoutFlushTime = Date.now();
          flushStdoutQueue();
        }, delay);
      }
    }

    return true;
  } as any;

  originalErrWrite = process.stderr.write;
  process.stderr.write = function (
    chunk: any,
    encoding?: any,
    cb?: any
  ): boolean {
    let str = "";
    if (typeof chunk === "string") {
      str = chunk;
    } else if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
      str = chunk.toString((typeof encoding === "string" ? encoding : "utf8") as any);
    }

    const callback = typeof encoding === "function" ? encoding : cb;
    stderrQueue.push({ chunk: str, cb: callback });

    if (!stderrScheduled) {
      stderrScheduled = true;
      const now = Date.now();
      const elapsed = now - lastStderrFlushTime;
      const interval = getAdaptiveFlushInterval();
      const useCoalesce = tuiPhase === "splash" || tuiPhase === "welcome";

      if (elapsed >= interval && !useCoalesce) {
        process.nextTick(() => {
          lastStderrFlushTime = Date.now();
          flushStderrQueue();
        });
      } else {
        const delay = useCoalesce ? Math.max(8, interval - elapsed) : (interval - elapsed);
        if (stderrFlushTimeout) clearTimeout(stderrFlushTimeout);
        stderrFlushTimeout = setTimeout(() => {
          lastStderrFlushTime = Date.now();
          flushStderrQueue();
        }, delay);
      }
    }

    return true;
  } as any;
}

export function leaveAlternateScreen(): void {
  if (!process.stdout.isTTY || !active) return;

  if (stdoutFlushTimeout) {
    clearTimeout(stdoutFlushTimeout);
    stdoutFlushTimeout = null;
  }
  if (stderrFlushTimeout) {
    clearTimeout(stderrFlushTimeout);
    stderrFlushTimeout = null;
  }

  flushStdoutQueue();
  flushStderrQueue();

  if (originalWrite) {
    process.stdout.write = originalWrite;
    originalWrite = null;
  }
  if (originalErrWrite) {
    process.stderr.write = originalErrWrite;
    originalErrWrite = null;
  }
  process.stdout.write("\x1b[?2026l\x1b[?25h\x1b[?1007l\x1b[?1049l\x1b[?7h");
  process.stderr.write("\x1b[?25h");

  // Force clean up of lag monitor interval to release loop handle
  if (lagInterval) {
    clearInterval(lagInterval);
  }

  // Restore raw mode and pause stdin to return terminal input control to PowerShell/Cmd
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  } catch {}

  active = false;
}


