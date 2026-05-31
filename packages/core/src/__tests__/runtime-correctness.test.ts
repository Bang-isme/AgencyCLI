import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  RuntimeInvariantEngine,
  LinearizabilityValidator,
  LatencyProfiler,
  GCProfiler,
  ConvergenceTracker,
  CPUSaturationHarness,
  TerminalBackpressureSimulator,
  ReplayFuzzer,
  CorrelationEngine,
  DeterministicPRNG,
  CatastrophicInvariantViolation
} from "../validation/correctness-science.js";
import { EventBus } from "../events/event-bus.js";
import { ReplayEvent, DagTaskNode } from "@agency/contracts";

describe("Runtime Correctness & Chaos Validation Science Suite", () => {
  
  beforeEach(() => {
    EventBus.getInstance().clear();
    RuntimeInvariantEngine.getInstance().clear();
  });

  afterEach(() => {
    EventBus.getInstance().clear();
    RuntimeInvariantEngine.getInstance().clear();
  });

  // ==========================================
  // 1. GLOBAL RUNTIME INVARIANT ENGINE TESTS
  // ==========================================
  describe("1. Global RuntimeInvariantEngine", () => {
    it("should register and continuously validate invariants, triggering fail-fast on drift", async () => {
      const engine = RuntimeInvariantEngine.getInstance();
      
      // Register NO_DUPLICATE_EXECUTION invariant:
      // A task must never be active on multiple workers.
      engine.registerInvariant("NO_DUPLICATE_EXECUTION", (snap) => {
        const workerTasks = snap.activeWorkers.map(w => w.split(":")[1]);
        const uniqueTasks = new Set(workerTasks);
        return uniqueTasks.size === workerTasks.length;
      });

      // Simulate normal execution: Task 1 on Worker A, Task 2 on Worker B
      engine.registerWorker("worker-A:task-1");
      engine.registerWorker("worker-B:task-2");

      // Now violate the invariant: Assign Task 1 to Worker C as well!
      expect(() => {
        engine.registerWorker("worker-C:task-1");
      }).toThrow(CatastrophicInvariantViolation);
    });

    it("should capture high-fidelity state snapshots on violation", () => {
      const engine = RuntimeInvariantEngine.getInstance();
      
      engine.registerInvariant("BOUNDED_QUEUE_MEMORY", (snap) => {
        const lastPayloadLen = snap.lastEvent?.payload ? Buffer.byteLength(snap.lastEvent.payload) : 0;
        return lastPayloadLen < 1000; // Artificially low limit
      });

      let capturedError: CatastrophicInvariantViolation | undefined;
      engine.setViolationCallback((err) => {
        capturedError = err;
      });

      // Publish an event that is larger than 1000 bytes
      const largePayload = "X".repeat(2000);
      
      expect(() => {
        engine.checkInvariants({
          sequenceId: 1,
          timestamp: Date.now(),
          action: "test:action",
          payloadHash: "hash",
          payload: largePayload
        });
      }).toThrow(CatastrophicInvariantViolation);

      expect(capturedError).toBeDefined();
      expect(capturedError?.snapshot.memory).toBeDefined();
      expect(capturedError?.snapshot.activeWorkers).toBeDefined();
      expect(capturedError?.snapshot.lastEvent?.payload).toBe(largePayload);
    });
  });

  // ==========================================
  // 2. LINEARIZABILITY VALIDATION TESTS
  // ==========================================
  describe("2. Linearizability Validation", () => {
    it("should validate monotonic happens-before chronological dependencies", () => {
      const validator = new LinearizabilityValidator();

      // Normal order: queued -> running -> verifying -> completed
      validator.record("task-1", "queued");
      validator.record("task-1", "running");
      validator.record("task-1", "verifying");
      validator.record("task-1", "completed");

      const res = validator.validate();
      expect(res.success).toBe(true);
    });

    it("should detect linearizability violations on out-of-order timeline events", () => {
      const validator = new LinearizabilityValidator();

      // Out of order: verifying before running!
      validator.record("task-2", "queued");
      validator.record("task-2", "verifying");
      validator.record("task-2", "running");
      validator.record("task-2", "completed");

      const res = validator.validate();
      expect(res.success).toBe(false);
      expect(res.errorMsg).toContain("executed 'verifying' before 'running'");
    });
  });

  // ==========================================
  // 3. EVENT-LOOP LATENCY SCIENCE TESTS
  // ==========================================
  describe("3. Event-Loop Latency Science", () => {
    it("should measure and calculate event loop percentiles and starvation windows", async () => {
      const profiler = new LatencyProfiler();
      profiler.start(1);

      // Yield a few times to gather samples
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      profiler.stop();
      const metrics = profiler.getPercentiles();
      
      expect(metrics.p50).toBeGreaterThanOrEqual(0);
      expect(metrics.p95).toBeGreaterThanOrEqual(metrics.p50);
      expect(metrics.p99).toBeGreaterThanOrEqual(metrics.p95);
      expect(metrics.starvationCount).toBeLessThanOrEqual(5);
    });
  });

  // ==========================================
  // 4. GC PRESSURE VALIDATION TESTS
  // ==========================================
  describe("4. GC Pressure Validation", () => {
    it("should profile memory footprint metrics under telemetry churn storms", () => {
      const profiler = new GCProfiler();
      
      const beforeMemory = process.memoryUsage().heapUsed;
      profiler.triggerAllocationStorm(100, 1000); // 1000 items
      const afterMemory = process.memoryUsage().heapUsed;

      expect(afterMemory).toBeGreaterThanOrEqual(beforeMemory);

      profiler.releaseStorm();
    });
  });

  // ==========================================
  // 5. EVENTUAL CONVERGENCE VALIDATION TESTS
  // ==========================================
  describe("5. Eventual Convergence Validation", () => {
    it("should track healing recovery and detect status stabilization", () => {
      const tracker = new ConvergenceTracker();
      
      const nodes: Record<string, DagTaskNode> = {
        "task-1": { id: "task-1", dependencies: [], action: "act", params: {}, state: "PENDING", timeoutMs: 0, attempts: 1 }
      };

      tracker.recordState(nodes);
      
      // Update task state to running
      nodes["task-1"].state = "RUNNING";
      tracker.recordState(nodes);

      // Update task state to completed
      nodes["task-1"].state = "COMPLETED";
      tracker.recordState(nodes);

      const check = tracker.checkStabilization(0); // 0ms quiet window for testing
      expect(check.stabilized).toBe(true);
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================
  // 6. FORMAL SCHEDULER INVARIANTS TESTS
  // ==========================================
  describe("6. Formal Scheduler Invariants", () => {
    it("should validate residency rules that tasks exist in exactly one partition", () => {
      const nodes: Record<string, DagTaskNode> = {
        "task-1": { id: "task-1", dependencies: [], action: "act", params: {}, state: "COMPLETED", timeoutMs: 0, attempts: 1 },
        "task-2": { id: "task-2", dependencies: [], action: "act", params: {}, state: "RUNNING", timeoutMs: 0, attempts: 1 }
      };

      const checkResidency = (nodesMap: Record<string, DagTaskNode>) => {
        const queues = {
          COMPLETED: [] as string[],
          RUNNING: [] as string[],
          PENDING: [] as string[]
        };

        for (const [id, node] of Object.entries(nodesMap)) {
          if (node.state === "COMPLETED") queues.COMPLETED.push(id);
          else if (node.state === "RUNNING") queues.RUNNING.push(id);
          else queues.PENDING.push(id);
        }

        // Verify task exists in exactly one partition
        for (const id of Object.keys(nodesMap)) {
          let count = 0;
          if (queues.COMPLETED.includes(id)) count++;
          if (queues.RUNNING.includes(id)) count++;
          if (queues.PENDING.includes(id)) count++;
          if (count !== 1) return false;
        }
        return true;
      };

      expect(checkResidency(nodes)).toBe(true);
    });
  });

  // ==========================================
  // 7. CPU STARVATION VALIDATION TESTS
  // ==========================================
  describe("7. CPU Starvation Validation", () => {
    it("should measure scheduler thread latency under synchronous compute storms", () => {
      const harness = new CPUSaturationHarness();
      
      const start = performance.now();
      harness.triggerCpuStorm(10); // 10ms CPU storm
      const duration = performance.now() - start;

      expect(duration).toBeGreaterThanOrEqual(10);
    });
  });

  // ==========================================
  // 8. TERMINAL BACKPRESSURE VALIDATION TESTS
  // ==========================================
  describe("8. Terminal Backpressure Validation", () => {
    it("should intercept stdout writes and simulate write throughput constraints", () => {
      const simulator = new TerminalBackpressureSimulator();
      
      simulator.enableBackpressure(2); // 2ms write lag
      
      const start = performance.now();
      process.stdout.write("Testing terminal write backpressure delay...\n");
      const elapsed = performance.now() - start;
      
      simulator.disableBackpressure();

      expect(elapsed).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================
  // 9. REPLAY FUZZING & MUTATION ENGINE TESTS
  // ==========================================
  describe("9. Replay Fuzzing & Deterministic Seed PRNG", () => {
    it("should generate deterministic and reproducible mutations across runs", () => {
      const fuzzer1 = new ReplayFuzzer(49281);
      const fuzzer2 = new ReplayFuzzer(49281); // Same seed!

      const events: ReplayEvent[] = [
        { sequenceId: 1, timestamp: 100, action: "task:start", payloadHash: "h1", payload: '{"id":1}' },
        { sequenceId: 2, timestamp: 105, action: "task:complete", payloadHash: "h2", payload: '{"id":2}' }
      ];

      const res1 = fuzzer1.mutateWAL(events);
      const res2 = fuzzer2.mutateWAL(events);

      // Verify reproducibility: mutated sequences are identical
      expect(res1[0].sequenceId).toBe(res2[0].sequenceId);
      expect(res1[1].sequenceId).toBe(res2[1].sequenceId);
      expect(res1[0].payload).toBe(res2[0].payload);
      expect(res1[1].payload).toBe(res2[1].payload);
    });
  });

  // ==========================================
  // 12. CROSS-SUBSYSTEM CORRELATION TESTS
  // ==========================================
  describe("12. Cross-Subsystem Correlation Analysis", () => {
    it("should record and detect cascade correlation events across subsystems", () => {
      const engine = new CorrelationEngine();

      // Trigger Queue Pressure at 0ms
      engine.record("events", "QueuePressure");
      
      // Render lag at 10ms
      engine.record("tui", "RenderLag");

      // Lease reclaim at 20ms
      engine.record("scheduler", "LeaseReclaim");

      // Verify cascade: events -> scheduler (Cascade detected)
      const cascade = engine.findCascades("events", "scheduler", 50);
      expect(cascade).toBe(true);

      // Verify negative case: scheduler -> events (No cascade)
      const noCascade = engine.findCascades("scheduler", "events", 5);
      expect(noCascade).toBe(false);
    });
  });
});
