import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, ToolDefinition } from "../tool-registry.js";
import { ExecutionContext } from "@agency/contracts";

describe("ToolRegistry Subsystem", () => {
  const registry = new ToolRegistry();

  const makeCtx = (): ExecutionContext => ({
    sessionId: "sess-1",
    traceId: "trace-1",
    workspaceId: "ws-1",
    cancellationToken: { aborted: false },
    governanceContext: {
      tokenBudgetLimit: 1000,
      tokensConsumed: 0,
      costCeilingUsd: 1.0,
      costConsumedUsd: 0,
      maxAttemptsLimit: 3,
    },
    retrievalScope: [],
    schedulerScope: [],
    sandboxScope: "ws-1",
  });

  const addTool: ToolDefinition<z.ZodObject<{ a: z.ZodNumber; b: z.ZodNumber }>> = {
    name: "add",
    description: "Adds two numbers",
    schema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    category: "read",
    execute: async (args) => args.a + args.b,
  };

  registry.register(addTool);

  it("should validate and execute tool successfully", async () => {
    const res = await registry.invoke("add", { a: 10, b: 20 }, makeCtx());
    expect(res).toBe(30);
  });

  it("should fail-closed if parameters are invalid", async () => {
    await expect(registry.invoke("add", { a: "not-a-number", b: 20 }, makeCtx())).rejects.toThrow();
  });

  it("should execute pre- and post-execution governance hooks", async () => {
    const localRegistry = new ToolRegistry();
    localRegistry.register(addTool);

    let preHookCalled = false;
    let postHookCalled = false;

    localRegistry.addPreExecuteHook((name, args, context) => {
      preHookCalled = true;
      expect(name).toBe("add");
      expect(args).toEqual({ a: 5, b: 5 });
      expect(context.sessionId).toBe("sess-1");
    });

    localRegistry.addPostExecuteHook((name, args, result, context) => {
      postHookCalled = true;
      expect(name).toBe("add");
      expect(result).toBe(10);
      expect(context.sessionId).toBe("sess-1");
    });

    const res = await localRegistry.invoke("add", { a: 5, b: 5 }, makeCtx());
    expect(res).toBe(10);
    expect(preHookCalled).toBe(true);
    expect(postHookCalled).toBe(true);
  });
});
