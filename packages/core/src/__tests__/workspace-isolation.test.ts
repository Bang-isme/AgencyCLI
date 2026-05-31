import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllDbs } from "@agency/memory";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE_SKILLS = join(REPO_ROOT, "tests", "fixtures", "mock-skills");

// Mock execa and routing
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../router/model-router.js", () => ({
  routeUserPrompt: vi.fn(),
}));

import { execa } from "execa";
import { routeUserPrompt } from "../router/model-router.js";
import {
  createIsolatedWorkspace,
  detectWorkspaceChanges,
  mergeWorkspaceChanges,
  cleanIsolatedWorkspace,
} from "../agents/workspace-isolation.js";
import { dispatchAgentsParallel } from "../agents/orchestrator.js";

const mockedExeca = vi.mocked(execa);
const mockedRoute = vi.mocked(routeUserPrompt);

const baseRoute = {
  intent: "plan",
  suggested_agent: "planner",
  workflow: "plan",
  skills: [],
  provider: "anthropic" as const,
  warnings: [],
};

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-ws-test-"));
  writeFileSync(join(dir, "package.json"), '{"name":"test-project"}');
  writeFileSync(join(dir, "file1.txt"), "hello world");
  writeFileSync(join(dir, "file2.txt"), "lorem ipsum");
  
  // create directories that should be excluded
  const nodeModules = join(dir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(nodeModules, "dummy.js"), "console.log(1)");

  const agency = join(dir, ".agency");
  mkdirSync(agency, { recursive: true });
  writeFileSync(join(agency, "cache.json"), "{}");

  return dir;
}

function mkdirSync(dir: string, opts?: { recursive: boolean }) {
  const fs = require("node:fs");
  fs.mkdirSync(dir, opts);
}

describe("workspace-isolation", () => {
  let projectRoot: string;

  afterEach(() => {
    vi.clearAllMocks();
    closeAllDbs();
    if (projectRoot && existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("createIsolatedWorkspace copies files excluding EXCLUDE_LIST", () => {
    projectRoot = makeTempProject();
    const ws = createIsolatedWorkspace(projectRoot, "planner");

    expect(existsSync(ws.tempDir)).toBe(true);
    expect(existsSync(join(ws.tempDir, "package.json"))).toBe(true);
    expect(existsSync(join(ws.tempDir, "file1.txt"))).toBe(true);
    
    // Should exclude node_modules and .agency
    expect(existsSync(join(ws.tempDir, "node_modules"))).toBe(false);
    expect(existsSync(join(ws.tempDir, ".agency"))).toBe(false);

    cleanIsolatedWorkspace(ws);
    expect(existsSync(ws.tempDir)).toBe(false);
  });

  it("detectWorkspaceChanges detects modification, creation, deletion", () => {
    projectRoot = makeTempProject();
    const ws = createIsolatedWorkspace(projectRoot, "planner");

    // 1. No changes initially
    let changes = detectWorkspaceChanges(ws);
    expect(changes.createdOrModified).toEqual([]);
    expect(changes.deleted).toEqual([]);

    // 2. Modify file
    writeFileSync(join(ws.tempDir, "file1.txt"), "hello modified");
    changes = detectWorkspaceChanges(ws);
    expect(changes.createdOrModified).toEqual(["file1.txt"]);
    expect(changes.deleted).toEqual([]);

    // 3. Create new file
    writeFileSync(join(ws.tempDir, "file3.txt"), "new file");
    changes = detectWorkspaceChanges(ws);
    expect(changes.createdOrModified.sort()).toEqual(["file1.txt", "file3.txt"]);

    // 4. Delete file
    rmSync(join(ws.tempDir, "file2.txt"), { force: true });
    changes = detectWorkspaceChanges(ws);
    expect(changes.createdOrModified.sort()).toEqual(["file1.txt", "file3.txt"]);
    expect(changes.deleted).toEqual(["file2.txt"]);

    cleanIsolatedWorkspace(ws);
  });

  it("mergeWorkspaceChanges safely merges and rejects conflicts", () => {
    projectRoot = makeTempProject();
    const ws1 = createIsolatedWorkspace(projectRoot, "planner");
    const ws2 = createIsolatedWorkspace(projectRoot, "debugger");

    // Modify file1 in ws1
    writeFileSync(join(ws1.tempDir, "file1.txt"), "ws1 change");
    
    // Modify file2 in ws2
    writeFileSync(join(ws2.tempDir, "file2.txt"), "ws2 change");

    // Merge changes
    const mergeRes = mergeWorkspaceChanges([ws1, ws2], projectRoot);
    expect(mergeRes.success).toBe(true);
    expect(mergeRes.mergedFiles.sort()).toEqual(["file1.txt", "file2.txt"]);
    expect(mergeRes.conflicts).toEqual([]);

    expect(readFileSync(join(projectRoot, "file1.txt"), "utf8")).toBe("ws1 change");
    expect(readFileSync(join(projectRoot, "file2.txt"), "utf8")).toBe("ws2 change");

    // Cleanup
    cleanIsolatedWorkspace(ws1);
    cleanIsolatedWorkspace(ws2);

    // Conflict case
    const ws3 = createIsolatedWorkspace(projectRoot, "planner");
    const ws4 = createIsolatedWorkspace(projectRoot, "debugger");

    writeFileSync(join(ws3.tempDir, "file1.txt"), "ws3 change");
    writeFileSync(join(ws4.tempDir, "file1.txt"), "ws4 change");

    const mergeResConflict = mergeWorkspaceChanges([ws3, ws4], projectRoot);
    expect(mergeResConflict.success).toBe(false);
    expect(mergeResConflict.conflicts).toEqual(["file1.txt"]);

    cleanIsolatedWorkspace(ws3);
    cleanIsolatedWorkspace(ws4);
  });
});

describe("dispatchAgentsParallel", () => {
  let projectRoot: string;

  afterEach(() => {
    vi.clearAllMocks();
    closeAllDbs();
    if (projectRoot && existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("dispatches multiple agents concurrently and merges their work", async () => {
    projectRoot = makeTempProject();

    mockedRoute.mockResolvedValue(baseRoute);
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        intent: "plan",
        suggested_agent: "planner",
        workflow: "plan",
        skills: [],
      }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    // We need to simulate the subagents actually writing to files in their isolated workspaces
    // To do this, we can intercept the mockedRoute call or execa call, or mock how dispatchAgent works.
    // However, since we mock execa, let's mock it in a way that writes a file to the temp directory!
    mockedExeca.mockImplementation(async (file: string, args: string[], options: any) => {
      // options.cwd is the tempDir of the isolated workspace
      if (options && options.cwd) {
        // Find which agent it is based on the env
        const agentId = options.env?.AGENCY_AGENT_ID;
        if (agentId === "planner") {
          writeFileSync(join(options.cwd, "file1.txt"), "agent planner wrote this");
        } else if (agentId === "debugger") {
          writeFileSync(join(options.cwd, "file2.txt"), "agent debugger wrote this");
        }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ suggested_agent: "planner" }),
        stderr: "",
      } as any;
    });

    const res = await dispatchAgentsParallel(projectRoot, [
      { agentId: "planner", task: "Write specs" },
      { agentId: "debugger", task: "Fix bugs" },
    ], { skillsRoot: FIXTURE_SKILLS });

    expect(res.success).toBe(true);
    expect(res.results.length).toBe(2);
    expect(res.mergeResult?.success).toBe(true);
    expect(res.mergeResult?.mergedFiles.sort()).toEqual(["file1.txt", "file2.txt"]);

    // Verify main project files have been updated
    expect(readFileSync(join(projectRoot, "file1.txt"), "utf8")).toBe("agent planner wrote this");
    expect(readFileSync(join(projectRoot, "file2.txt"), "utf8")).toBe("agent debugger wrote this");
  });
});
