import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { join } from "node:path";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

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

describe("Milestone 10: PTY Buffer Release and Stream Cache Cleanup (T1)", () => {
  let daemonProcess: any;
  let serverConfig: { url: string; token: string; pid: number } | null = null;

  beforeAll(async () => {
    if (existsSync(serverJsonPath)) {
      try {
        unlinkSync(serverJsonPath);
      } catch {}
    }

    daemonProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot], {
      env: { ...process.env },
    });
    daemonProcess.catch(() => {});

    let attempts = 0;
    while (attempts < 50) {
      if (existsSync(serverJsonPath)) {
        try {
          serverConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
          if (serverConfig && serverConfig.url) {
            break;
          }
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!serverConfig) {
      throw new Error("Failed to start daemon server for PTY cleanup tests");
    }
  });

  afterAll(async () => {
    if (daemonProcess) {
      await stopServer(daemonProcess, serverConfig);
    }
  });

  it("should release PTY buffers and delete sessions on WebSocket close under parallel runs", async () => {
    const wsUrl = serverConfig!.url.replace("http://", "ws://");
    const numSessions = 5;
    const sessionIds = Array.from({ length: numSessions }, (_, i) => `parallel-session-cleanup-${i}`);

    // 1. Trigger parallel execution runs to populate PTY buffers
    for (const sessionId of sessionIds) {
      const res = await fetch(`${serverConfig!.url}/sessions/${sessionId}/wake`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serverConfig!.token}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(200);
    }

    // 2. Connect WebSocket clients to capture active streams
    const wsConnections: WebSocket[] = [];
    const receivedData: Record<string, string> = {};

    await Promise.all(
      sessionIds.map(
        (sessionId) =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`${wsUrl}/pty/${sessionId}?token=${serverConfig!.token}`);
            wsConnections.push(ws);
            receivedData[sessionId] = "";

            ws.on("open", () => {
              // Wait until we receive at least some PTY buffer data
              ws.on("message", (data) => {
                receivedData[sessionId] += data.toString();
                if (receivedData[sessionId].includes("processing turn")) {
                  resolve();
                }
              });
            });

            ws.on("error", reject);
            
            // Timeout safety
            setTimeout(() => {
              if (!receivedData[sessionId]) {
                reject(new Error(`WebSocket connection timeout for session ${sessionId}`));
              }
            }, 3000);
          })
      )
    );

    // Verify all sessions streams got output
    for (const sessionId of sessionIds) {
      expect(receivedData[sessionId]).toContain("processing turn");
    }

    // 3. Disconnect all WebSocket clients
    await Promise.all(
      wsConnections.map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.on("close", () => resolve());
            ws.close();
          })
      )
    );

    // Since steps are 4, each 200ms, and we have a 5-second session cleanup grace period,
    // wait 6000ms to ensure the turn simulation completes and the grace period expires.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // 5. Connect new WebSocket clients with cursor=0 to check if PTY buffer is released
    // If the session was deleted and PTY buffer released, cursor=0 should yield NO bytes.
    // If it wasn't, the server would send the buffered output.
    await Promise.all(
      sessionIds.map(
        (sessionId) =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(
              `${wsUrl}/pty/${sessionId}?token=${serverConfig!.token}&cursor=0`
            );
            let receivedNewData = false;

            ws.on("open", () => {
              ws.on("message", () => {
                receivedNewData = true;
              });

              // Wait 500ms to verify no message is sent back
              setTimeout(() => {
                ws.close();
                expect(receivedNewData).toBe(false); // Buffer was released!
                resolve();
              }, 500);
            });

            ws.on("error", reject);
          })
      )
    );
  });
});
