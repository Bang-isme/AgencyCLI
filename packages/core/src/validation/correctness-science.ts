import { ReplayEvent, DagTaskNode } from "@agency/contracts";
import { EventBus } from "../events/event-bus.js";

// ==========================================
// 11. DETERMINISTIC SEED-DRIVEN PRNG
// ==========================================
export class DeterministicPRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed ? seed : 123456789;
  }

  /** LCG Generator (Linear Congruential Generator) */
  public next(): number {
    this.state = (this.state * 1664525 + 1013904223) % 4294967296;
    return this.state / 4294967296;
  }

  public nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  public shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

// ==========================================
// 1. GLOBAL RUNTIME INVARIANT ENGINE
// ==========================================
export interface RuntimeSnapshot {
  timestamp: number;
  memory: NodeJS.MemoryUsage;
  queueBytes: number;
  activeWorkers: string[];
  nodesState: Record<string, string>;
  lastEvent?: ReplayEvent;
}

export type InvariantPredicate = (snapshot: RuntimeSnapshot) => boolean;

export class CatastrophicInvariantViolation extends Error {
  public snapshot: RuntimeSnapshot;
  constructor(message: string, snapshot: RuntimeSnapshot) {
    super(message);
    this.name = "CatastrophicInvariantViolation";
    this.snapshot = snapshot;
  }
}

export class RuntimeInvariantEngine {
  private static instance: RuntimeInvariantEngine;
  private invariants = new Map<string, InvariantPredicate>();
  private activeWorkers = new Set<string>();
  private nodesState: Record<string, string> = {};
  private isFrozen = false;
  private violationCallback?: (err: CatastrophicInvariantViolation) => void;

  public static getInstance(): RuntimeInvariantEngine {
    if (!RuntimeInvariantEngine.instance) {
      RuntimeInvariantEngine.instance = new RuntimeInvariantEngine();
    }
    return RuntimeInvariantEngine.instance;
  }

  private constructor() {
    // Automatically hook up to the global EventBus
    EventBus.getInstance().subscribe("*", (evt) => {
      if (this.isFrozen) return;
      this.processEvent(evt);
    });
  }

  public registerInvariant(name: string, predicate: InvariantPredicate): void {
    this.invariants.set(name, predicate);
  }

  public clear(): void {
    this.invariants.clear();
    this.activeWorkers.clear();
    this.nodesState = {};
    this.isFrozen = false;
  }

  public registerWorker(workerId: string): void {
    this.activeWorkers.add(workerId);
    this.checkInvariants();
  }

  public unregisterWorker(workerId: string): void {
    this.activeWorkers.delete(workerId);
    this.checkInvariants();
  }

  public updateNodeState(nodeId: string, state: string): void {
    this.nodesState[nodeId] = state;
    this.checkInvariants();
  }

  public setViolationCallback(cb: (err: CatastrophicInvariantViolation) => void): void {
    this.violationCallback = cb;
  }

  private processEvent(event: ReplayEvent): void {
    const act = event.action.toLowerCase();
    if (act.includes("worker:started")) {
      try {
        const payload = JSON.parse(event.payload);
        if (payload.workerId) this.activeWorkers.add(payload.workerId);
      } catch {}
    } else if (act.includes("worker:stopped") || act.includes("worker:killed")) {
      try {
        const payload = JSON.parse(event.payload);
        if (payload.workerId) this.activeWorkers.delete(payload.workerId);
      } catch {}
    } else if (act.includes("task:state")) {
      try {
        const payload = JSON.parse(event.payload);
        if (payload.taskId && payload.state) {
          this.nodesState[payload.taskId] = payload.state;
        }
      } catch {}
    }

    this.checkInvariants(event);
  }

  public checkInvariants(lastEvent?: ReplayEvent): void {
    if (this.isFrozen) return;

    const snapshot: RuntimeSnapshot = {
      timestamp: Date.now(),
      memory: process.memoryUsage(),
      queueBytes: (EventBus.getInstance() as any).currentQueueBytes || 0,
      activeWorkers: Array.from(this.activeWorkers),
      nodesState: { ...this.nodesState },
      lastEvent
    };

    for (const [name, predicate] of this.invariants.entries()) {
      if (!predicate(snapshot)) {
        this.isFrozen = true; // Freeze system immediately
        const violationErr = new CatastrophicInvariantViolation(
          `Catastrophic invariant violation detected: [${name}]`,
          snapshot
        );
        if (this.violationCallback) {
          this.violationCallback(violationErr);
        }
        throw violationErr;
      }
    }
  }
}

// ==========================================
// 2. LINEARIZABILITY VALIDATION
// ==========================================
export interface CausalEvent {
  taskId: string;
  action: "queued" | "running" | "verifying" | "completed";
  timestamp: number;
}

export class LinearizabilityValidator {
  private events: CausalEvent[] = [];

  public record(taskId: string, action: "queued" | "running" | "verifying" | "completed"): void {
    this.events.push({ taskId, action, timestamp: performance.now() });
  }

  public clear(): void {
    this.events = [];
  }

  /**
   * Validates Happens-Before relationship ordering.
   * queued -> running -> verifying -> completed.
   */
  public validate(): { success: boolean; errorMsg?: string } {
    const taskTimelines = new Map<string, Record<string, number>>();
    
    for (const ev of this.events) {
      if (!taskTimelines.has(ev.taskId)) {
        taskTimelines.set(ev.taskId, {});
      }
      taskTimelines.get(ev.taskId)![ev.action] = ev.timestamp;
    }

    for (const [taskId, timeline] of taskTimelines.entries()) {
      const q = timeline["queued"];
      const r = timeline["running"];
      const v = timeline["verifying"];
      const c = timeline["completed"];

      if (q !== undefined && r !== undefined && q > r) {
        return { success: false, errorMsg: `Task ${taskId} executed 'running' before 'queued'.` };
      }
      if (r !== undefined && v !== undefined && r > v) {
        return { success: false, errorMsg: `Task ${taskId} executed 'verifying' before 'running'.` };
      }
      if (v !== undefined && c !== undefined && v > c) {
        return { success: false, errorMsg: `Task ${taskId} executed 'completed' before 'verifying'.` };
      }
    }

    return { success: true };
  }
}

// ==========================================
// 3. EVENT-LOOP LATENCY SCIENCE
// ==========================================
export class LatencyProfiler {
  private samples: number[] = [];
  private activeInterval?: NodeJS.Timeout;
  private lastTime = performance.now();
  private starvationEvents = 0;

  public start(intervalMs = 1): void {
    this.samples = [];
    this.starvationEvents = 0;
    this.lastTime = performance.now();
    this.activeInterval = setInterval(() => {
      const now = performance.now();
      const delay = Math.max(0, now - this.lastTime - intervalMs);
      this.samples.push(delay);
      if (delay >= 50) {
        this.starvationEvents++;
      }
      this.lastTime = now;
    }, intervalMs);
  }

  public stop(): void {
    if (this.activeInterval) {
      clearInterval(this.activeInterval);
      this.activeInterval = undefined;
    }
  }

  public getPercentiles(): { p50: number; p95: number; p99: number; starvationCount: number } {
    if (this.samples.length === 0) return { p50: 0, p95: 0, p99: 0, starvationCount: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const getPercentile = (p: number) => {
      const idx = Math.floor((p / 100) * sorted.length);
      return sorted[Math.min(idx, sorted.length - 1)];
    };
    return {
      p50: getPercentile(50),
      p95: getPercentile(95),
      p99: getPercentile(99),
      starvationCount: this.starvationEvents
    };
  }
}

// ==========================================
// 4. GC PRESSURE VALIDATION
// ==========================================
export class GCProfiler {
  private allocations: any[] = [];

  /**
   * Generates a high heap-churn allocation storm.
   */
  public triggerAllocationStorm(payloadSize = 1024, count = 50_000): void {
    this.allocations = [];
    for (let i = 0; i < count; i++) {
      this.allocations.push({
        id: `ephemeral-${i}`,
        data: "X".repeat(payloadSize),
        timestamp: Date.now()
      });
    }
  }

  public releaseStorm(): void {
    this.allocations = [];
    if (global.gc) {
      global.gc();
    }
  }
}

// ==========================================
// 5. EVENTUAL CONVERGENCE VALIDATION
// ==========================================
export class ConvergenceTracker {
  private stateHistory: { timestamp: number; stateStr: string }[] = [];

  public recordState(nodes: Record<string, DagTaskNode>): void {
    const stateStr = Object.values(nodes)
      .map((n) => `${n.id}:${n.state}`)
      .sort()
      .join("|");
    this.stateHistory.push({ timestamp: performance.now(), stateStr });
  }

  public clear(): void {
    this.stateHistory = [];
  }

  public checkStabilization(maxQuietWindowMs = 200): { stabilized: boolean; durationMs: number } {
    if (this.stateHistory.length < 2) return { stabilized: true, durationMs: 0 };
    
    const start = this.stateHistory[0].timestamp;
    let lastChangeTime = start;
    let currentVal = this.stateHistory[0].stateStr;

    for (let i = 1; i < this.stateHistory.length; i++) {
      if (this.stateHistory[i].stateStr !== currentVal) {
        currentVal = this.stateHistory[i].stateStr;
        lastChangeTime = this.stateHistory[i].timestamp;
      }
    }

    const elapsedSinceLastChange = performance.now() - lastChangeTime;
    const stabilized = elapsedSinceLastChange >= maxQuietWindowMs;
    const durationMs = lastChangeTime - start;

    return { stabilized, durationMs };
  }
}

// ==========================================
// 7. CPU STARVATION VALIDATION
// ==========================================
export class CPUSaturationHarness {
  public triggerCpuStorm(durationMs = 50): void {
    const start = performance.now();
    while (performance.now() - start < durationMs) {
      // Burn CPU cycles synchronously
      Math.sqrt(Math.random() * 100000);
    }
  }
}

// ==========================================
// 8. TERMINAL BACKPRESSURE VALIDATION
// ==========================================
export class TerminalBackpressureSimulator {
  private originalWrite = process.stdout.write;
  private delayMs = 0;

  public enableBackpressure(delayMs = 2): void {
    this.delayMs = delayMs;
    process.stdout.write = (chunk: any, encoding?: any, callback?: any): boolean => {
      const cb = typeof encoding === "function" ? encoding : callback;
      const start = performance.now();
      while (performance.now() - start < this.delayMs) {
        // Block writing synchronously to simulate SSH/tmux buffer backpressure
      }
      return this.originalWrite.call(process.stdout, chunk, encoding, cb);
    };
  }

  public disableBackpressure(): void {
    process.stdout.write = this.originalWrite;
  }
}

// ==========================================
// 9. REPLAY FUZZING & MUTATION ENGINE
// ==========================================
export class ReplayFuzzer {
  private prng: DeterministicPRNG;

  constructor(seed: number) {
    this.prng = new DeterministicPRNG(seed);
  }

  /**
   * Applies mutations to a sequence of WAL logs.
   */
  public mutateWAL(events: ReplayEvent[]): ReplayEvent[] {
    const mutated = [...events];
    const mutationType = this.prng.nextInt(1, 3);

    if (mutated.length < 2) return mutated;

    if (mutationType === 1) {
      // Swapping sequence IDs
      const idx = this.prng.nextInt(0, mutated.length - 2);
      const tempId = mutated[idx].sequenceId;
      mutated[idx] = { ...mutated[idx], sequenceId: mutated[idx + 1].sequenceId };
      mutated[idx + 1] = { ...mutated[idx + 1], sequenceId: tempId };
    } else if (mutationType === 2) {
      // JSON Payloads truncation
      const idx = this.prng.nextInt(0, mutated.length - 1);
      mutated[idx] = { ...mutated[idx], payload: mutated[idx].payload.slice(0, -5) };
    } else if (mutationType === 3) {
      // State parameter swap
      const idx = this.prng.nextInt(0, mutated.length - 1);
      mutated[idx] = { ...mutated[idx], action: "invalid:action:corrupt" };
    }

    return mutated;
  }
}

// ==========================================
// 12. CROSS-SUBSYSTEM CORRELATION ANALYSIS
// ==========================================
export class CorrelationEngine {
  private timeline: { timestamp: number; subsystem: string; event: string }[] = [];

  public record(subsystem: string, event: string): void {
    this.timeline.push({ timestamp: Date.now(), subsystem, event });
  }

  public clear(): void {
    this.timeline = [];
  }

  /** Checks if Subsystem A triggers cascades in Subsystem B */
  public findCascades(subA: string, subB: string, windowMs = 50): boolean {
    for (let i = 0; i < this.timeline.length; i++) {
      if (this.timeline[i].subsystem === subA) {
        const timeA = this.timeline[i].timestamp;
        for (let j = i + 1; j < this.timeline.length; j++) {
          if (this.timeline[j].subsystem === subB && this.timeline[j].timestamp - timeA <= windowMs) {
            return true; // Correlation cascade confirmed!
          }
        }
      }
    }
    return false;
  }
}
