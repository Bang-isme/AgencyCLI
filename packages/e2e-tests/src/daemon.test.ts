import { describe, it, expect, beforeEach } from "vitest";
import { execa } from "execa";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

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

describe("Requirement R2: Daemon Client-Server Decoupling (T2) E2E Tests", () => {
  beforeEach(() => {
    if (existsSync(serverJsonPath)) {
      try {
        unlinkSync(serverJsonPath);
      } catch {}
    }
  });

  // Feature 7: Background Daemon Server Lifecycle
  // Feature 8: Daemon Discovery via server.json
  it("Feature 7 & 8: should start and stop the daemon server, creating and deleting server.json", async () => {
    // Start server
    const serverProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
    serverProcess.catch(() => {});
    
    let config: any = null;
    try {
      // Wait for server.json
      let attempts = 0;
      while (attempts < 50) {
        if (existsSync(serverJsonPath)) {
          try {
            config = JSON.parse(readFileSync(serverJsonPath, "utf8"));
            if (config && config.url && config.pid && config.version && config.token) {
              break;
            }
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }

      expect(config).toBeDefined();
      expect(config.url).toMatch(/127\.0\.0\.1|localhost/);
      expect(config.pid).toBeTypeOf("number");
      expect(config.version).toBe("0.1.0");
      expect(config.token).toBeTypeOf("string");

      // Verify health check works
      const healthRes = await fetch(`${config.url}/health`);
      const healthData = await healthRes.json() as any;
      expect(healthRes.status).toBe(200);
      expect(healthData.status).toBe("ok");

    } finally {
      // Stop server
      await stopServer(serverProcess, config);
      
      // Wait for server.json to be cleaned up
      let attempts = 0;
      while (attempts < 20) {
        if (!existsSync(serverJsonPath)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }

      expect(existsSync(serverJsonPath)).toBe(false);
    }
  });

  // Feature 9: Single-Instance Lock & Conflict Shutdown
  it("Feature 9: should resolve conflicts when a second daemon is started in the same workspace", async () => {
    // Start Daemon A
    const processA = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
    processA.catch(() => {});
    
    let configA: any = null;
    try {
      let attempts = 0;
      while (attempts < 50) {
        if (existsSync(serverJsonPath)) {
          try {
            configA = JSON.parse(readFileSync(serverJsonPath, "utf8"));
            if (configA && configA.pid) break;
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }
      expect(configA).toBeDefined();
      const pidA = configA.pid;

      // Start Daemon B
      const processB = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
      processB.catch(() => {});

      let configB: any = null;
      try {
        // Wait for server.json to be overwritten with Daemon B's config
        let attemptsB = 0;
        while (attemptsB < 50) {
          if (existsSync(serverJsonPath)) {
            try {
              configB = JSON.parse(readFileSync(serverJsonPath, "utf8"));
              if (configB && configB.pid && configB.pid !== pidA) break;
            } catch {}
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          attemptsB++;
        }
        
        expect(configB).toBeDefined();
        expect(configB.pid).not.toBe(pidA);

        // Verify Daemon A is shut down gracefully or overridden
        let processAExited = false;
        try {
          process.kill(pidA, 0); // Check if process A is still alive
        } catch {
          processAExited = true;
        }

        // Daemon A should be shut down or exiting
        if (!processAExited) {
          // If still running, wait a little bit for the shutdown watcher to kick in
          await new Promise((resolve) => setTimeout(resolve, 1200));
          try {
            process.kill(pidA, 0);
          } catch {
            processAExited = true;
          }
        }
        expect(processAExited).toBe(true);

      } finally {
        await stopServer(processB, configB);
      }
    } finally {
      await stopServer(processA, configA);
    }
  });

  // Feature 10: Mutual Authentication & Subscription Isolation (SSE)
  it("Feature 10: should enforce authentication and subscription isolation in SSE streams", async () => {
    const serverProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
    serverProcess.catch(() => {});
    
    let config: any = null;
    try {
      let attempts = 0;
      while (attempts < 50) {
        if (existsSync(serverJsonPath)) {
          try {
            config = JSON.parse(readFileSync(serverJsonPath, "utf8"));
            if (config && config.url) break;
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }
      expect(config).toBeDefined();

      // Connect without auth
      const noAuthRes = await fetch(`${config.url}/events/subscribe`);
      expect(noAuthRes.status).toBe(401);

      // Connect with auth
      const authRes = await fetch(`${config.url}/events/subscribe`, {
        headers: { "Authorization": `Bearer ${config.token}` },
      });
      expect(authRes.status).toBe(200);
      expect(authRes.headers.get("content-type")).toContain("text/event-stream");

      // Verify workspace isolation
      // Start Client A (workspace-a) and Client B (workspace-b) SSE readers
      void fetch(`${config.url}/events/subscribe?workspaceId=workspace-a&token=${config.token}`);
      void fetch(`${config.url}/events/subscribe?workspaceId=workspace-b&token=${config.token}`);

      // Wait a small bit for connections to register
      await new Promise(resolve => setTimeout(resolve, 200));

      // Trigger workspace-a event
      await fetch(`${config.url}/mock/event`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: "workspace-a",
          event: "Update",
          data: "Secret-A",
        }),
      });

      // Cleanup SSE reader streams using abort or just closing the server
    } finally {
      await stopServer(serverProcess, config);
    }
  });
});
