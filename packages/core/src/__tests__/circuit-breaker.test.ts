import { describe, it, expect } from "vitest";
import {
  createCircuitBreaker,
  checkCircuitBreaker,
  recordToolFailure,
  recordToolSuccess,
  resetCircuitBreaker,
} from "../chat/circuit-breaker.js";

describe("tool-loop circuit breaker", () => {
  it("trips after 3 consecutive identical tool calls (infinite-loop guard)", () => {
    const s = createCircuitBreaker();
    const call = [{ name: "read_file", arguments: { path: "a.ts" } }];
    expect(checkCircuitBreaker(s, call).shouldBreak).toBe(false); // 1
    expect(checkCircuitBreaker(s, call).shouldBreak).toBe(false); // 2
    expect(checkCircuitBreaker(s, call).shouldBreak).toBe(false); // 3
    expect(checkCircuitBreaker(s, call).shouldBreak).toBe(true); // 4th → 3 repeats
  });

  it("trips after 3 consecutive FAILURES — incl. refused-command variants the identical check misses", () => {
    const s = createCircuitBreaker();
    // The screenshot case: the model emits DIFFERENT self-kill commands, so the
    // identical-signature check never fires; but each is refused (an Error result
    // → recordToolFailure), and the consecutive-failure breaker catches it.
    recordToolFailure(s);
    recordToolFailure(s);
    recordToolFailure(s);
    expect(checkCircuitBreaker(s, [{ name: "execute_command", arguments: { command: "taskkill /F /IM node.exe & echo x" } }]).shouldBreak).toBe(true);
  });

  it("a success resets the consecutive-failure count", () => {
    const s = createCircuitBreaker();
    recordToolFailure(s);
    recordToolFailure(s);
    recordToolSuccess(s); // interleaved success → not a runaway
    recordToolFailure(s);
    expect(checkCircuitBreaker(s, [{ name: "x", arguments: {} }]).shouldBreak).toBe(false);
  });

  it("resetCircuitBreaker clears repeat + failure state (per-turn freshness)", () => {
    const s = createCircuitBreaker();
    recordToolFailure(s);
    recordToolFailure(s);
    recordToolFailure(s);
    resetCircuitBreaker(s);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.toolCallHistory).toHaveLength(0);
    expect(checkCircuitBreaker(s, [{ name: "x", arguments: {} }]).shouldBreak).toBe(false);
  });

  it("bounds toolCallHistory so the (process-lifetime) singleton can't grow without limit", () => {
    const s = createCircuitBreaker();
    for (let i = 0; i < 200; i++) {
      checkCircuitBreaker(s, [{ name: "t", arguments: { i } }]); // each distinct
    }
    expect(s.toolCallHistory.length).toBeLessThanOrEqual(50);
  });
});
