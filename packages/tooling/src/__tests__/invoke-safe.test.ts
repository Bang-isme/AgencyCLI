import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../tool-registry.js";

const ctx = {} as any;

function makeRegistry() {
  const r = new ToolRegistry();
  r.register({
    name: "ok_tool",
    description: "always succeeds",
    category: "read",
    schema: z.object({ x: z.number() }),
    execute: async (args) => `got ${args.x}`,
  });
  r.register({
    name: "boom_tool",
    description: "always throws",
    category: "read",
    schema: z.object({}),
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  return r;
}

describe("ToolRegistry.invokeSafe", () => {
  it("returns ok with the result on success", async () => {
    const r = makeRegistry();
    const res = await r.invokeSafe("ok_tool", { x: 5 }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toBe("got 5");
  });

  it("never throws when the handler throws", async () => {
    const r = makeRegistry();
    const res = await r.invokeSafe("boom_tool", {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("execution");
    expect(res.error).toContain("kaboom");
  });

  it("classifies validation failures without throwing", async () => {
    const r = makeRegistry();
    const res = await r.invokeSafe("ok_tool", { x: "not-a-number-and-uncoercible" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("validation");
  });

  it("reports unregistered tools as data", async () => {
    const r = makeRegistry();
    const res = await r.invokeSafe("ghost_tool", {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("not_registered");
  });
});
