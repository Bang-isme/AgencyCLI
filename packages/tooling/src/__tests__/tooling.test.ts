import { describe, expect, it } from "vitest";
import { z } from "zod";
import { spawn } from "node:child_process";
import { JSONRepairEngine } from "../json-repair.js";
import { CoercionLayer } from "../coercion-layer.js";
import { PluginSupervisor } from "../plugin-supervisor.js";

describe("packages/tooling", () => {
  describe("JSONRepairEngine", () => {
    it("repairs trailing commas", () => {
      const jre = new JSONRepairEngine();
      const repaired = jre.repair('{"a": 1, "b": [1, 2, ], }');
      expect(JSON.parse(repaired)).toEqual({ a: 1, b: [1, 2] });
    });

    it("extracts and parses json block from markdown codeblock", () => {
      const jre = new JSONRepairEngine();
      const raw = "Here is your JSON:\n```json\n{\n  \"foo\": \"bar\"\n}\n```\nHope it helps!";
      const repaired = jre.repair(raw);
      expect(JSON.parse(repaired)).toEqual({ foo: "bar" });
    });

    it("balances unclosed brackets and braces", () => {
      const jre = new JSONRepairEngine();
      const repaired = jre.repair('{"a": {"b": [1, 2');
      expect(JSON.parse(repaired)).toEqual({ a: { b: [1, 2] } });
    });

    it("escapes unescaped newlines inside strings", () => {
      const jre = new JSONRepairEngine();
      const repaired = jre.repair('{"text": "line1\nline2"}');
      expect(JSON.parse(repaired)).toEqual({ text: "line1\nline2" });
    });
  });

  describe("CoercionLayer", () => {
    it("coerces stringified primitives to booleans and numbers via JSON Schema", () => {
      const cl = new CoercionLayer();
      const rawArgs = { active: "true", count: "123", skip: "0" };
      const schema = {
        properties: {
          active: { type: "boolean" },
          count: { type: "number" },
          skip: { type: "boolean" },
        },
      };

      const coerced = cl.coerceJsonSchema(rawArgs, schema);
      expect(coerced).toEqual({ active: true, count: 123, skip: false });
    });

    it("coerces stringified primitives for Zod validation", () => {
      const cl = new CoercionLayer();
      const rawArgs = { active: "true", count: "45" };
      const zodSchema = z.object({
        active: z.boolean(),
        count: z.number(),
      });

      const res = cl.coerceAndValidateZod(rawArgs, zodSchema);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ active: true, count: 45 });
    });
  });

  describe("PluginSupervisor", () => {
    it("can register, heartbeat, and terminate a node process", async () => {
      const ps = new PluginSupervisor();
      // Spawn a lightweight long-running node process
      const proc = spawn("node", ["-e", "setInterval(() => {}, 1000)"]);

      ps.registerProcess("plugin-test", proc, 200);
      expect(ps.isHealthy("plugin-test")).toBe(true);

      // Refresh heartbeat
      ps.heartbeat("plugin-test");
      expect(ps.isHealthy("plugin-test")).toBe(true);

      // Terminate
      await ps.terminate("plugin-test");
      expect(ps.isHealthy("plugin-test")).toBe(false);
      expect(proc.killed).toBe(true);
    });
  });
});
