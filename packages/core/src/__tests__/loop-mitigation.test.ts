import { describe, it, expect, afterAll } from "vitest";
import { executeTool } from "../skill/tool-harness.js";
import { createCircuitBreaker, recordToolFailure } from "../chat/circuit-breaker.js";
import { handleLoopMitigation } from "../chat/loop-mitigation.js";
import { EventBus } from "../events/event-bus.js";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

describe("Loop Mitigation & File Truncation Gate", () => {
  const testFile = join(process.cwd(), "truncation-gate-test.ts");

  afterAll(() => {
    if (existsSync(testFile)) {
      try {
        unlinkSync(testFile);
      } catch {}
    }
  });

  it("File Truncation Gate rejects write_file on large files if they exist", async () => {
    // Write 110 lines to testFile
    const lines = Array.from({ length: 110 }, (_, i) => `console.log(${i});`).join("\n");
    writeFileSync(testFile, lines, "utf8");

    // Execute write_file on this path
    const result = await executeTool(
      "write_file",
      { path: testFile, content: "console.log('short overwrite');" },
      process.cwd()
    );

    expect(result).toContain("Error: Large file detected");
    expect(result).toContain("looks truncated");
  });

  it("File Truncation Gate permits full rewrite of a large existing file", async () => {
    const lines = Array.from({ length: 110 }, (_, i) => `console.log(${i});`).join("\n");
    writeFileSync(testFile, lines, "utf8");

    const fullRewrite = `${lines}\nconsole.log('rebuilt');`;
    const result = await executeTool(
      "write_file",
      { path: testFile, content: fullRewrite },
      process.cwd()
    );

    expect(result).toContain("Success");
  });

  it("File Truncation Gate permits write_file on new files", async () => {
    const newTestFile = join(process.cwd(), "truncation-gate-new.ts");
    if (existsSync(newTestFile)) {
      unlinkSync(newTestFile);
    }

    try {
      const result = await executeTool(
        "write_file",
        { path: newTestFile, content: "console.log('new file');" },
        process.cwd()
      );
      expect(result).toContain("Success");
    } finally {
      if (existsSync(newTestFile)) {
        unlinkSync(newTestFile);
      }
    }
  });

  it("Tầng 1: Self-Reflection is injected at 3 consecutive failures", async () => {
    const state = createCircuitBreaker();
    // Simulate 3 failures
    recordToolFailure(state);
    recordToolFailure(state);
    recordToolFailure(state);

    // Target a file so it detects semantic loop
    state.lastModifiedFiles.push("some-file.ts");

    const history: any[] = [];
    const context = {
      agentId: "test-agent",
      conversationId: "test-conv",
      projectRoot: process.cwd(),
      waitForResume: true,
    };

    const res = await handleLoopMitigation(state, history, context);
    expect(res.action).toBe("continue");
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("system");
    expect(history[0].content).toContain("SYSTEM WARNING");
    expect(state.hasInjectedReflection).toBe(true);
  });

  it("Tầng 2: Live Grill Pauses at 5 failures and resumes on loop:resume", async () => {
    const state = createCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      recordToolFailure(state);
    }

    const history: any[] = [];
    const context = {
      agentId: "test-agent",
      conversationId: "test-conv",
      projectRoot: process.cwd(),
      waitForResume: true,
    };

    // We start the mitigation promise
    const promise = handleLoopMitigation(state, history, context);

    // Publish loop:resume event to simulate TUI/user feedback
    setTimeout(() => {
      EventBus.getInstance().publish("loop:resume", {
        agentId: "test-agent",
        conversationId: "test-conv",
        action: "resume",
        feedback: "Try another module import"
      });
    }, 100);

    const res = await promise;
    expect(res.action).toBe("continue");
    expect(res.feedback).toBe("Try another module import");
  });

  it("Tầng 2: Live Grill aborts immediately when no resume handler is attached", async () => {
    const state = createCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      recordToolFailure(state);
    }

    const res = await handleLoopMitigation(state, [], {
      agentId: "test-agent",
      conversationId: "test-conv",
      projectRoot: process.cwd(),
    });

    expect(res.action).toBe("abort");
    expect(res.feedback).toContain("no interactive resume handler");
  });
});
