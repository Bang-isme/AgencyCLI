import { createHash } from "node:crypto";

export interface ClockProvider {
  now(): number;
  setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): any;
  clearTimeout(id: any): void;
  setInterval(callback: (...args: any[]) => void, ms: number, ...args: any[]): any;
  clearInterval(id: any): void;
}

export interface EntropyProvider {
  random(): number;
  uuidv4(): string;
}

/**
 * Seedable pseudo-random generator (Mulberry32).
 */
export class DeterministicEntropy implements EntropyProvider {
  private state: number;

  constructor(seed: string | number) {
    if (typeof seed === "string") {
      const hash = createHash("sha256").update(seed).digest("hex");
      this.state = parseInt(hash.substring(0, 8), 16);
    } else {
      this.state = seed;
    }
  }

  /**
   * Mulberry32 algorithm.
   */
  public random(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public uuidv4(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (this.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

interface ScheduledTask {
  id: number;
  runAt: number;
  callback: (...args: any[]) => void;
  args: any[];
  intervalMs?: number;
}

export class DeterministicClock implements ClockProvider {
  private currentTime: number;
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  constructor(startTime = 0) {
    this.currentTime = startTime;
  }

  public now(): number {
    return this.currentTime;
  }

  public setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): number {
    const id = this.nextId++;
    this.tasks.push({
      id,
      runAt: this.currentTime + ms,
      callback,
      args,
    });
    this.tasks.sort((a, b) => a.runAt - b.runAt);
    return id;
  }

  public clearTimeout(id: any): void {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }

  public setInterval(callback: (...args: any[]) => void, ms: number, ...args: any[]): number {
    const id = this.nextId++;
    const scheduleNext = (task: ScheduledTask) => {
      task.runAt = this.currentTime + ms;
      this.tasks.push(task);
      this.tasks.sort((a, b) => a.runAt - b.runAt);
    };

    const wrapper = (...innerArgs: any[]) => {
      // Re-schedule first to preserve timeline consistency
      const task = this.tasks.find((t) => t.id === id);
      if (task) {
        scheduleNext(task);
      }
      callback(...innerArgs);
    };

    const taskObj: ScheduledTask = {
      id,
      runAt: this.currentTime + ms,
      callback: wrapper,
      args,
      intervalMs: ms,
    };

    this.tasks.push(taskObj);
    this.tasks.sort((a, b) => a.runAt - b.runAt);
    return id;
  }

  public clearInterval(id: any): void {
    this.clearTimeout(id);
  }

  /**
   * Advances the clock by the specified milliseconds, executing any scheduled tasks.
   */
  public tick(ms: number): void {
    const endTime = this.currentTime + ms;
    while (this.tasks.length > 0 && this.tasks[0].runAt <= endTime) {
      const task = this.tasks.shift()!;
      this.currentTime = task.runAt;
      try {
        task.callback(...task.args);
      } catch (err) {
        console.error("Error in deterministic clock scheduled task:", err);
      }
    }
    this.currentTime = endTime;
  }

  public getPendingTasksCount(): number {
    return this.tasks.length;
  }
}

/**
 * Deterministic Promise.race implementation.
 * Guarantees that if multiple promises settle in the same microtask turn,
 * they are resolved/rejected strictly by their index in the input list.
 */
export function deterministicPromiseRace<T>(promises: Iterable<PromiseLike<T> | T>): Promise<T> {
  const promiseArray = Array.from(promises);
  if (promiseArray.length === 0) {
    return new Promise(() => {}); // never settles
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let microtaskQueued = false;
    const settledQueue: { value?: any; error?: any; index: number; resolved: boolean }[] = [];

    const processQueue = () => {
      if (settled) return;
      settledQueue.sort((a, b) => a.index - b.index);
      const winner = settledQueue[0];
      settled = true;
      if (winner.resolved) {
        resolve(winner.value);
      } else {
        reject(winner.error);
      }
    };

    promiseArray.forEach((p, index) => {
      Promise.resolve(p).then(
        (val) => {
          if (settled) return;
          settledQueue.push({ value: val, index, resolved: true });
          if (!microtaskQueued) {
            microtaskQueued = true;
            queueMicrotask(processQueue);
          }
        },
        (err) => {
          if (settled) return;
          settledQueue.push({ error: err, index, resolved: false });
          if (!microtaskQueued) {
            microtaskQueued = true;
            queueMicrotask(processQueue);
          }
        }
      );
    });
  });
}

/**
 * Overrides global Date, setTimeout, and Promise.race with deterministic versions.
 * Returns an object to restore the originals.
 */
export function installDeterministicGlobals(clock: DeterministicClock, entropy: DeterministicEntropy) {
  const originalDate = globalThis.Date;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalMathRandom = globalThis.Math.random;
  const originalPromiseRace = globalThis.Promise.race;

  // Custom Date replacement
  const MockDate = function (this: any, ...args: any[]) {
    if (args.length === 0) {
      return new originalDate(clock.now());
    }
    // @ts-ignore
    return new originalDate(...args);
  };
  MockDate.now = () => clock.now();
  MockDate.UTC = originalDate.UTC;
  MockDate.parse = originalDate.parse;
  MockDate.prototype = originalDate.prototype;

  // Global assignments
  // @ts-ignore
  globalThis.Date = MockDate;
  // @ts-ignore
  globalThis.setTimeout = (cb, ms, ...args) => clock.setTimeout(cb, ms || 0, ...args);
  // @ts-ignore
  globalThis.clearTimeout = (id) => clock.clearTimeout(id);
  // @ts-ignore
  globalThis.setInterval = (cb, ms, ...args) => clock.setInterval(cb, ms || 0, ...args);
  // @ts-ignore
  globalThis.clearInterval = (id) => clock.clearInterval(id);
  globalThis.Math.random = () => entropy.random();
  // @ts-ignore
  globalThis.Promise.race = deterministicPromiseRace;

  return {
    restore: () => {
      globalThis.Date = originalDate;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      globalThis.Math.random = originalMathRandom;
      globalThis.Promise.race = originalPromiseRace;
    },
  };
}
