import { describe, expect, it } from "vitest";
import {
  DeterministicClock,
  DeterministicEntropy,
  installDeterministicGlobals,
  deterministicPromiseRace,
} from "../kernel/entropy-provider.js";

describe("Entropy & Time Isolation Subsystem", () => {
  it("should generate seedable deterministic random values", () => {
    const entropy1 = new DeterministicEntropy("test-seed");
    const entropy2 = new DeterministicEntropy("test-seed");
    const entropy3 = new DeterministicEntropy("other-seed");

    const r1_a = entropy1.random();
    const r1_b = entropy1.random();

    const r2_a = entropy2.random();
    const r2_b = entropy2.random();

    const r3_a = entropy3.random();

    expect(r1_a).toBe(r2_a);
    expect(r1_b).toBe(r2_b);
    expect(r1_a).not.toBe(r3_a);
  });

  it("should generate deterministic UUIDs", () => {
    const entropy1 = new DeterministicEntropy("my-seed");
    const entropy2 = new DeterministicEntropy("my-seed");

    const uuid1 = entropy1.uuidv4();
    const uuid2 = entropy2.uuidv4();

    expect(uuid1).toBe(uuid2);
    expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("should mock Date and setTimeout chronologically via DeterministicClock", () => {
    const clock = new DeterministicClock(1000);
    let timeoutFired = false;
    let timeoutValue = 0;

    clock.setTimeout((val) => {
      timeoutFired = true;
      timeoutValue = val;
    }, 500, 42);

    expect(clock.now()).toBe(1000);
    expect(timeoutFired).toBe(false);

    clock.tick(200);
    expect(clock.now()).toBe(1200);
    expect(timeoutFired).toBe(false);

    clock.tick(300);
    expect(clock.now()).toBe(1500);
    expect(timeoutFired).toBe(true);
    expect(timeoutValue).toBe(42);
  });

  it("should enforce deterministic Promise.race resolution ordering", async () => {
    // Standard promise race can be non-deterministic if multiple promises settle in the same microtask tick.
    // deterministicPromiseRace guarantees order of array win for same microtask tick.
    let resolvedValue: number | undefined;

    const p1 = new Promise<number>((resolve) => {
      queueMicrotask(() => resolve(1));
    });
    const p2 = new Promise<number>((resolve) => {
      queueMicrotask(() => resolve(2));
    });

    resolvedValue = await deterministicPromiseRace([p2, p1]);
    expect(resolvedValue).toBe(2);

    const q1 = new Promise<number>((resolve) => {
      queueMicrotask(() => resolve(1));
    });
    const q2 = new Promise<number>((resolve) => {
      queueMicrotask(() => resolve(2));
    });
    resolvedValue = await deterministicPromiseRace([q1, q2]);
    expect(resolvedValue).toBe(1);
  });

  it("should install and restore global overrides", () => {
    const clock = new DeterministicClock(5000);
    const entropy = new DeterministicEntropy("globals-test");

    const originalRandom = Math.random;
    const originalNow = Date.now;

    const installer = installDeterministicGlobals(clock, entropy);

    expect(Date.now()).toBe(5000);
    const r1 = Math.random();
    const expectedEntropy = new DeterministicEntropy("globals-test");
    expect(r1).toBe(expectedEntropy.random());

    installer.restore();

    expect(Math.random).toBe(originalRandom);
    expect(Date.now).toBe(originalNow);
  });
});
