import { describe, expect, it, vi } from "vitest";
import { runVerifyLoop } from "../task/verify-loop.js";

describe("runVerifyLoop", () => {
  it("passes on the first round with no retry", async () => {
    const attempt = vi.fn(async () => {});
    const verify = vi.fn(async () => ({ passed: true, failures: "" }));
    const r = await runVerifyLoop(attempt, verify, { maxRounds: 3 });
    expect(r).toMatchObject({ success: true, rounds: 1, stopReason: "passed" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries with the previous failures fed back, then succeeds", async () => {
    const seen: Array<string | undefined> = [];
    let round = 0;
    const r = await runVerifyLoop(
      async (ctx) => {
        seen.push(ctx.previousFailures);
      },
      async () => {
        round++;
        return round === 1
          ? { passed: false, failures: "build broke: X" }
          : { passed: true, failures: "" };
      },
      { maxRounds: 3 }
    );
    expect(r.success).toBe(true);
    expect(r.rounds).toBe(2);
    expect(seen).toEqual([undefined, "build broke: X"]);
  });

  it("stops at maxRounds when it never passes (distinct failures)", async () => {
    let n = 0;
    const r = await runVerifyLoop(
      async () => {},
      async () => ({ passed: false, failures: `err ${n++}` }),
      { maxRounds: 3, noProgressLimit: 5 }
    );
    expect(r).toMatchObject({ success: false, rounds: 3, stopReason: "max-rounds" });
  });

  it("stops early on no progress when an identical failure repeats", async () => {
    const attempt = vi.fn(async () => {});
    const r = await runVerifyLoop(
      attempt,
      async () => ({ passed: false, failures: "same error", signature: "E" }),
      { maxRounds: 5, noProgressLimit: 2 }
    );
    expect(r.stopReason).toBe("no-progress");
    expect(r.rounds).toBe(2);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("stops when the budget check fails before a round", async () => {
    const attempt = vi.fn(async () => {});
    let budgetChecks = 0;
    const r = await runVerifyLoop(
      attempt,
      async () => ({ passed: false, failures: "x" }),
      { maxRounds: 5, hasBudget: () => ++budgetChecks <= 1 }
    );
    expect(r.stopReason).toBe("budget-exhausted");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does a single attempt when maxRounds is 1 (legacy behaviour)", async () => {
    const attempt = vi.fn(async () => {});
    const r = await runVerifyLoop(attempt, async () => ({ passed: false, failures: "nope" }), {
      maxRounds: 1,
    });
    expect(r).toMatchObject({ success: false, rounds: 1, stopReason: "max-rounds" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
