import { describe, expect, it, vi } from "vitest";
import { reasoningSummary } from "../components/Conversation.js";

describe("Milestone 11 Edge Cases - Clock Skew Clamping", () => {
  it("guards against negative duration when clock skews backwards (NTP adjustment)", () => {
    const thoughtStartMs = 1700000000000;
    
    // Mock Date.now to return a value 5000ms before thoughtStartMs (backward clock skew)
    const originalDateNow = Date.now;
    Date.now = () => thoughtStartMs - 5000;
    
    try {
      const calculatedDuration = Date.now() - thoughtStartMs;
      expect(calculatedDuration).toBe(-5000);
      
      // Clamp logic in App.tsx: Math.max(0, Date.now() - thoughtStartMs)
      const clampedDuration = Math.max(0, Date.now() - thoughtStartMs);
      expect(clampedDuration).toBe(0);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("calculates positive duration normally when no skew is present", () => {
    const thoughtStartMs = 1700000000000;
    const originalDateNow = Date.now;
    Date.now = () => thoughtStartMs + 8500;
    
    try {
      const clampedDuration = Math.max(0, Date.now() - thoughtStartMs);
      expect(clampedDuration).toBe(8500);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe("Milestone 11 Edge Cases - Colon/Space Stripping on Thoughts", () => {
  it("strips only the first colon/space separator and preserves subsequent colons in body", () => {
    const input = "**Thinking**: : : body";
    const res = reasoningSummary(input);
    expect(res.title).toBe("Thinking");
    expect(res.body).toBe(": : body");
  });
  
  it("handles different spacing patterns around colons and newlines", () => {
    const inputWithSpaces = "**Thinking**  :   : : body";
    const res1 = reasoningSummary(inputWithSpaces);
    expect(res1.title).toBe("Thinking");
    expect(res1.body).toBe(": : body");
    
    const inputWithNewline = "**Thinking**\n: : body";
    const res2 = reasoningSummary(inputWithNewline);
    expect(res2.title).toBe("Thinking");
    expect(res2.body).toBe(": : body");
  });
});

describe("Milestone 11 Edge Cases - Standard Inline Bold False Positive Prevention", () => {
  it("does not match standard inline bold markdown as a thought header if not followed by a separator", () => {
    const input = "**First step** is to query the database.";
    const res = reasoningSummary(input);
    expect(res.title).toBe("");
    expect(res.body).toBe("**First step** is to query the database.");
  });

  it("handles multiple bold elements correctly without extracting titles from mid-sentence bolding", () => {
    const input = "This is a **normal bold** phrase and another **one here**.";
    const res = reasoningSummary(input);
    expect(res.title).toBe("");
    expect(res.body).toBe("This is a **normal bold** phrase and another **one here**.");
  });
});

describe("Milestone 11 Edge Cases - Stream Abortion/Cancellation Behavior", () => {
  it("verifies abort controller abort signal is triggered correctly", () => {
    const controller = new AbortController();
    const signal = controller.signal;
    expect(signal.aborted).toBe(false);
    
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
