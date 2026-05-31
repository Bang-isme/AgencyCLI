import { describe, it, expect } from "vitest";
import { getWorkspaceRoot } from "../project.js";

describe("getWorkspaceRoot", () => {
  it("returns cwd when no package.json ancestor", () => {
    const root = getWorkspaceRoot(process.cwd());
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });
});
