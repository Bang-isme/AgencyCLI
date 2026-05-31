import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DomainSpecialistRegistry } from "../agents/specialist-registry.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe("DomainSpecialistRegistry", () => {
  it("loads built-in specialists automatically", () => {
    const registry = DomainSpecialistRegistry.getInstance();
    const list = registry.listSpecialists();
    expect(list.some(s => s.id === "architect")).toBe(true);
    expect(list.some(s => s.id === "coder")).toBe(true);
    expect(list.some(s => s.id === "tester")).toBe(true);
    expect(list.some(s => s.id === "security-auditor")).toBe(true);

    const arch = registry.getSpecialist("architect");
    expect(arch?.name).toBe("System Architect");
    expect(arch?.clearanceLevel).toBe("HIGH");
  });

  it("can register in-memory specialists", () => {
    const registry = DomainSpecialistRegistry.getInstance();
    registry.registerSpecialist({
      id: "custom-agent",
      name: "Custom Agent",
      role: "Custom role",
      systemPrompt: "Custom prompt",
      skills: ["skill-a"],
      clearanceLevel: "MEDIUM",
    });

    const spec = registry.getSpecialist("custom-agent");
    expect(spec).toBeDefined();
    expect(spec?.name).toBe("Custom Agent");
  });

  it("loads and overrides workspace specialists if files exist", () => {
    const registry = DomainSpecialistRegistry.getInstance();
    const root = "/fake/project";

    // Setup override directory mocks
    mockedExistsSync.mockImplementation((path: any) => {
      if (typeof path === "string" && path.includes("override-agent.json")) return true;
      if (typeof path === "string" && path.endsWith(join(".agency", "specialists"))) return true;
      return false;
    });

    mockedReaddirSync.mockImplementation((path: any) => {
      if (typeof path === "string" && path.endsWith(join(".agency", "specialists"))) {
        return ["override-agent.json"] as any;
      }
      return [] as any;
    });

    mockedReadFileSync.mockImplementation((path: any) => {
      if (typeof path === "string" && path.includes("override-agent.json")) {
        return JSON.stringify({
          id: "override-agent",
          name: "Workspace Specialist",
          role: "Dynamic role",
          systemPrompt: "Dynamic prompt",
          skills: ["dynamic-skill"],
          clearanceLevel: "HIGH",
        });
      }
      throw new Error("File not found");
    });

    const spec = registry.getSpecialist("override-agent", root);
    expect(spec).toBeDefined();
    expect(spec?.name).toBe("Workspace Specialist");
    expect(spec?.clearanceLevel).toBe("HIGH");

    const all = registry.listSpecialists(root);
    expect(all.some(s => s.id === "override-agent")).toBe(true);
  });
});
