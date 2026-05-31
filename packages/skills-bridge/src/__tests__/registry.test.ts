import { describe, it, expect } from "vitest";
import { loadPluginTools } from "../registry.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "mock-skills");

describe("loadPluginTools", () => {
  it("loads pack_health from fixture", () => {
    const reg = loadPluginTools(FIXTURE);
    expect(reg.tools[0].name).toBe("pack_health");
  });
});
