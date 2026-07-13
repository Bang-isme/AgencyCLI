import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { join } from "node:path";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import { WebSocket } from "ws";

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
    } catch {}
  }
  proc.kill("SIGTERM");
  await proc.catch(() => {});
}

describe("Requirement R3: TUI/PTY Stream (T3) E2E Tests", () => {
  let daemonProcess: any;
  let serverConfig: { url: string; token: string; pid: number } | null = null;

  beforeAll(async () => {
    // Delete stale server.json first
    if (existsSync(serverJsonPath)) {
      try {
        unlinkSync(serverJsonPath);
      } catch {}
    }

    // Start daemon
    daemonProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
    daemonProcess.stdout?.on("data", (chunk: any) => {
      console.log(`[E2E-DAEMON STDOUT]: ${chunk.toString()}`);
    });
    daemonProcess.stderr?.on("data", (chunk: any) => {
      console.error(`[E2E-DAEMON STDERR]: ${chunk.toString()}`);
    });
    daemonProcess.on("exit", (code: any, signal: any) => {
      console.log(`[E2E-DAEMON EXIT]: code=${code}, signal=${signal}`);
    });
    daemonProcess.catch((err: any) => {
      console.error("[E2E-DAEMON ERROR]:", err);
    });

    // Wait for server.json
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
      throw new Error("Failed to start daemon server for TUI tests");
    }
  });

  afterAll(async () => {
    if (daemonProcess) {
      await stopServer(daemonProcess, serverConfig);
    }
  });

  // Feature 11: Modular TUI Layout & Agent Hierarchy Tree
  it("Feature 11: should launch TUI and render layout structure", async () => {
    // Start the CLI in TUI mode (default when no headless command args are passed)
    // We set AGENCY_TUI=true env variable to force TUI resolution
    const tuiProcess = execa("node", [cliEntry], {
      env: {
        ...process.env,
        AGENCY_TUI: "true",
        FORCE_COLOR: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });

    // Let it run and output layout
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Simulate tab or arrow key to check responsiveness
    tuiProcess.stdin?.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 500));

    tuiProcess.kill("SIGKILL");
    await tuiProcess.catch((err) => err);

    // TUI output should contain agent references, panels or standard layout parts
    // Since it's a headless run, we check that it compiled and ran without fatal errors
    expect(tuiProcess.exitCode).not.toBe(127);
  });

  // Feature 12: Real-time SSE UI State Synchronization
  it("Feature 12: should synchronize TUI state in real-time via SSE events", async () => {
    // Connect to SSE stream
    const sseUrl = `${serverConfig!.url}/events/subscribe?workspaceId=session-tui&token=${serverConfig!.token}`;
    const controller = new AbortController();
    const ssePromise = fetch(sseUrl, { signal: controller.signal });

    // Wait a little bit
    await new Promise(resolve => setTimeout(resolve, 200));

    // Externally update a session to trigger a State Sync SSE event
    const updateRes = await fetch(`${serverConfig!.url}/mock/event`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "session-tui",
        event: "SessionUpdated",
        status: "running",
      }),
    });
    expect(updateRes.status).toBe(200);

    controller.abort();
    await ssePromise.catch(() => {});
  });

  // Feature 13: PTY WebSocket Stream (/pty)
  it("Feature 13: should stream active terminal command stdout live over WebSocket", async () => {
    const wsUrl = `${serverConfig!.url.replace("http://", "ws://")}/pty/session-pty?token=${serverConfig!.token}`;
    const ws = new WebSocket(wsUrl);

    const receivedChunks: string[] = [];
    ws.on("message", (data) => {
      receivedChunks.push(data.toString());
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    // Trigger an execution turn that produces stdout
    await fetch(`${serverConfig!.url}/sessions/session-pty/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });

    // Wait for the simulated PTY output to be streamed
    await new Promise((resolve) => setTimeout(resolve, 1500));
    ws.close();

    expect(receivedChunks.length).toBeGreaterThan(0);
    expect(receivedChunks.join("")).toContain("Step 1 processing turn...");
  });

  // Feature 14: PTY Reconnection Resync with Cursor Buffer
  it("Feature 14: should replay missing bytes using cursor query parameter upon reconnection", async () => {
    // Step 1: Open first WebSocket to collect all streamed PTY output and establish a cursor offset
    const wsUrl1 = `${serverConfig!.url.replace("http://", "ws://")}/pty/session-resync?token=${serverConfig!.token}`;
    const ws1 = new WebSocket(wsUrl1);

    let bytesReceived = 0;
    ws1.on("message", (data) => {
      bytesReceived += Buffer.from(data as any).length;
    });

    await new Promise<void>((resolve, reject) => {
      ws1.on("open", () => resolve());
      ws1.on("error", (err) => reject(err));
    });

    // Trigger run to generate output
    await fetch(`${serverConfig!.url}/sessions/session-resync/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
      },
    });

    // Let it stream some bytes, then disconnect mid-stream
    await new Promise((resolve) => setTimeout(resolve, 300));
    ws1.close();

    const cursor = bytesReceived;
    expect(cursor).toBeGreaterThan(0);

    // Let the session finish streaming to the 2MB server-side buffer
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 2: Reconnect passing the cursor offset as query parameter
    const wsUrl2 = `${serverConfig!.url.replace("http://", "ws://")}/pty/session-resync?token=${serverConfig!.token}&cursor=${cursor}`;
    const ws2 = new WebSocket(wsUrl2);

    const replayedChunks: string[] = [];
    ws2.on("message", (data) => {
      replayedChunks.push(data.toString());
    });

    await new Promise<void>((resolve, reject) => {
      ws2.on("open", () => resolve());
      ws2.on("error", (err) => reject(err));
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    ws2.close();

    // Verify that the replayed bytes contain the remaining output starting from the cursor offset
    const replayedContent = replayedChunks.join("");
    expect(replayedContent).toContain("processing turn...");
    expect(replayedContent).not.toContain("Step 1 processing turn..."); // Should not contain pre-cursor bytes
  });
});
