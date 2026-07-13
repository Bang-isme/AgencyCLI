import { describe, it, expect, vi } from "vitest";
import { SessionRunCoordinator } from "../runtime/session-run-coordinator.js";

describe("SessionRunCoordinator", () => {
  it("should execute run and wake sequentially when idle", async () => {
    const runSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      // Mock run work
    });
    const wakeSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      // Mock wake work
    });

    const coordinator = new SessionRunCoordinator(runSpy, wakeSpy);

    await coordinator.run();
    expect(runSpy).toHaveBeenCalledTimes(1);

    await coordinator.wake();
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it("should verify lane coalescing and run upgrade", async () => {
    let runCount = 0;
    let wakeCount = 0;
    
    let firstRunDeferred = createDeferred();

    const runSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      runCount++;
      if (runCount === 1) {
        await firstRunDeferred.promise;
      }
    });

    const wakeSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      wakeCount++;
    });

    const coordinator = new SessionRunCoordinator(runSpy, wakeSpy);

    // 1. Start the first run (blocks on firstRunDeferred)
    const runPromise1 = coordinator.run();

    // 2. While the first run is active, call wake() twice
    const wakePromise1 = coordinator.wake();
    const wakePromise2 = coordinator.wake();

    // 3. Call run() which upgrades the pending/queued wake to a run.
    const runPromise2 = coordinator.run();

    // Resolve the first run
    firstRunDeferred.resolve();
    await runPromise1;

    // Await the others
    await Promise.all([wakePromise1, wakePromise2, runPromise2]);

    // Let's check call counts:
    // - first run executor was called (1)
    // - next execution was run upgrade (so second run executor was called) (1)
    // - total run executor calls = 2
    // - wake executor was never called (0) because it got upgraded!
    expect(runCount).toBe(2);
    expect(wakeCount).toBe(0);
  });

  it("should verify wake aborting when run is triggered", async () => {
    let wakeSignal: AbortSignal | null = null;
    let wakeDeferred = createDeferred();
    
    const runSpy = vi.fn();
    const wakeSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      wakeSignal = signal;
      await wakeDeferred.promise;
    });

    const coordinator = new SessionRunCoordinator(runSpy, wakeSpy);

    // 1. Start a wake (blocks on wakeDeferred)
    const wakePromise = coordinator.wake();

    // Give it a microtask tick to ensure the executor started and set wakeSignal
    await new Promise((r) => setImmediate(r));

    expect(wakeSignal).not.toBeNull();
    expect(wakeSignal!.aborted).toBe(false);

    // 2. Trigger run() which should abort the active wake immediately
    const runPromise = coordinator.run();

    expect(wakeSignal!.aborted).toBe(true);

    // Resolve the wake deferred
    wakeDeferred.resolve();

    await Promise.all([wakePromise, runPromise]);

    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("should verify old wake-clearing when a run starts", async () => {
    let firstRunDeferred = createDeferred();
    let runCount = 0;
    let wakeCount = 0;

    const runSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      runCount++;
      if (runCount === 1) {
        await firstRunDeferred.promise;
      }
    });

    const wakeSpy = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      wakeCount++;
    });

    const coordinator = new SessionRunCoordinator(runSpy, wakeSpy);

    // Start first run
    const runPromise1 = coordinator.run();

    // Queue wake
    const wakePromise = coordinator.wake();

    // Queue run
    const runPromise2 = coordinator.run();

    // Resolve first run
    firstRunDeferred.resolve();

    await Promise.all([runPromise1, wakePromise, runPromise2]);

    // The second run should execute, and the wake should be coalesced/cleared.
    expect(runCount).toBe(2);
    expect(wakeCount).toBe(0);
  });
});

function createDeferred() {
  let resolve!: () => void;
  let reject!: (err: any) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
