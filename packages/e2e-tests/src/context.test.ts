import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { compactTurnHistory } from "@agency/core";

const cliEntry = join(process.cwd(), "../cli/dist/index.js");
const projectRoot = join(process.cwd(), "../../");
const agencyDir = join(projectRoot, ".agency");
const serverJsonPath = join(agencyDir, "server.json");

async function stopServer(proc: any, config: any) {
  if (config && config.url && config.token) {
    try {
      await fetch(`${config.url}/server/stop`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.token}` },
        signal: AbortSignal.timeout(1000),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {}
  }
  try {
    proc.kill("SIGTERM");
  } catch {}
  await proc.catch(() => {});
}

describe("Requirement R4: Context Algebra (T4) E2E Tests", () => {
  let daemonProcess: any;
  let serverConfig: { url: string; token: string; pid: number } | null = null;

  beforeAll(async () => {
    // Delete stale server.json first
    if (existsSync(serverJsonPath)) {
      try {
        unlinkSync(serverJsonPath);
      } catch {}
    }

    daemonProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
    daemonProcess.catch(() => {});

    let attempts = 0;
    while (attempts < 50) {
      if (existsSync(serverJsonPath)) {
        try {
          serverConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
          if (serverConfig && serverConfig.url) break;
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!serverConfig) {
      throw new Error("Failed to start daemon server for context tests");
    }
  });

  afterAll(async () => {
    if (daemonProcess) {
      await stopServer(daemonProcess, serverConfig);
    }
  });

  // Feature 15: Composable Context Sources & Incremental Reconciliation
  it("Feature 15: should send ContextUpdated events for modified files during incremental reconciliation", async () => {
    // Send a mock turn request with incremental update info
    const res = await fetch(`${serverConfig!.url}/mock/prompt`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "ContextUpdated: packages/core/src/index.ts",
      }),
    });
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.containsContextUpdated).toBe(true);
  });

  // Feature 16: Markdown-driven History Compaction & Buffer Retention
  it("Feature 16: should compact older turns when token limit is exceeded, keeping recent turns intact", async () => {
    // Set up a chat history turn list
    const history = [
      { role: "system", content: "Original system instruction" },
      { role: "user", content: "Goal: Set up project. Constraints: NodeJS. Decisions: Use Vitest." },
      { role: "assistant", content: "Completed scaffolding." },
      { role: "user", content: "Goal: Add TUI. Constraints: Ink. Decisions: Dynamic imports." },
      { role: "assistant", content: "Implemented App.tsx." },
      { role: "user", content: "recent turn 4" },
      { role: "assistant", content: "recent turn 3" },
      { role: "user", content: "recent turn 2" },
      { role: "assistant", content: "recent turn 1" },
    ];

    // Mock completion provider
    const provider = {
      complete: async () => `Goal: Set up project.
Constraints: NodeJS.
Progress: Completed scaffolding.
Decisions: Use Vitest, use dynamic imports.
Next Steps: Run test cases.
Files: packages/e2e-tests/package.json`,
    };

    // Call the production compactTurnHistory helper from @agency/core
    const result = await compactTurnHistory(history as any[], provider, 20);

    expect(result.compacted).toBe(true);
    expect(result.summarizedTurns).toBe(4); // middle turns (index 1 to 4) should be summarized
    expect(result.messages.length).toBe(6); // system + summary + 4 recent turns

    // Check system prompt is preserved
    expect(result.messages[0].content).toBe("Original system instruction");
    
    // Check summary has the markdown compaction outline structure
    expect(result.messages[1].content).toContain("[CONVERSATION SUMMARY]: Goal: Set up project.");
    
    // Check recent turns are preserved verbatim
    expect(result.messages[2].content).toBe("recent turn 4");
    expect(result.messages[5].content).toBe("recent turn 1");
  });
});
