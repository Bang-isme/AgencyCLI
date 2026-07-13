import { Command } from "commander";
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getWorkspaceRoot, clearRunningSummaryCache } from "@agency/core";

// Global in-memory states to simulate real-time operations
interface SessionState {
  id: string;
  status: "idle" | "running";
  queue: ("run" | "wake")[];
  runningPromise?: Promise<void>;
  resolveRunning?: () => void;
  ptyBuffer: Buffer;
  wsClients: Set<WebSocket>;
  cleanupTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, SessionState>();

// Reusable 2MB buffer for PTY simulation
const PTY_BUFFER_SIZE = 2 * 1024 * 1024;
function getOrCreateSession(id: string): SessionState {
  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      status: "idle",
      queue: [],
      ptyBuffer: Buffer.alloc(0),
      wsClients: new Set(),
    };
    sessions.set(id, session);
  } else if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    delete session.cleanupTimer;
  }
  return session;
}

export function registerServer(program: Command) {
  program
    .command("server")
    .description("Daemon server controls")
    .command("start")
    .description("Start the background daemon server")
    .option("--port <port>", "Port to bind to", "0")
    .option("--project-root <path>", "Project root directory")
    .action(async (options: { port: string; projectRoot?: string }) => {
      const projectRoot = options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const agencyDir = join(projectRoot, ".agency");
      const serverJsonPath = join(agencyDir, "server.json");

      // Ensure directory exists
      mkdirSync(agencyDir, { recursive: true });

      // Feature 9: Single-Instance Lock & Conflict Shutdown
      if (existsSync(serverJsonPath)) {
        try {
          const oldConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
          if (oldConfig && oldConfig.pid) {
            try {
              // Try to check if process is alive and SIGTERM it
              process.kill(oldConfig.pid, "SIGTERM");
              // Wait slightly for old process to release resources
              await new Promise((resolve) => setTimeout(resolve, 500));
            } catch {
              // PID not running
            }
          }
        } catch {
          // JSON parsing failed, override
        }
      }

      // Generate a random token
      const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

      // Create SSE clients list
      const sseClients = new Set<{
        res: any;
        workspaceId?: string;
        directory?: string;
      }>();

      // Create HTTP Server
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        
        // Setup cors headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Allow-Methods", "*");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Endpoint: GET /health (no auth required)
        if (url.pathname === "/health" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }

        // Feature 10: Mutual Authentication - Check token header or query parameter
        const authHeader = req.headers["authorization"];
        const tokenQuery = url.searchParams.get("token");
        const clientToken = authHeader?.startsWith("Bearer ")
          ? authHeader.substring(7)
          : (tokenQuery ?? "");

        if (clientToken !== token) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // Endpoint: SSE subscribe
        if (url.pathname === "/events/subscribe") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const client = {
            res,
            workspaceId: url.searchParams.get("workspaceId") ?? undefined,
            directory: url.searchParams.get("directory") ?? undefined,
          };
          sseClients.add(client);

          req.on("close", () => {
            sseClients.delete(client);
          });

          // Send initial event
          res.write(`data: ${JSON.stringify({ event: "connected" })}\n\n`);
          return;
        }

        // Endpoint: POST /sessions/:id/wake
        const wakeMatch = url.pathname.match(/^\/sessions\/([^/]+)\/wake$/);
        if (wakeMatch && req.method === "POST") {
          const sessionId = wakeMatch[1]!;
          const session = getOrCreateSession(sessionId);

          // Feature 1: Trigger Classification / Feature 2: Lane Coalescing Queue
          // Check if already running or has pending wake
          if (session.status === "running") {
            const hasPendingWake = session.queue.includes("wake");
            if (!hasPendingWake) {
              session.queue.push("wake");
            }
            // Coalesced
          } else {
            session.status = "running";
            // Start simulation of running turn
            triggerTurnSimulation(session, "wake", sseClients);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "queued", queue: session.queue }));
          return;
        }

        // Endpoint: POST /sessions/:id/run
        const runMatch = url.pathname.match(/^\/sessions\/([^/]+)\/run$/);
        if (runMatch && req.method === "POST") {
          const sessionId = runMatch[1]!;
          const session = getOrCreateSession(sessionId);

          // Feature 3: Turn Priority Promotion
          if (session.status === "running") {
            // Promote wake queue to run
            session.queue = session.queue.map(q => q === "wake" ? "run" : q);
            if (!session.queue.includes("run")) {
              session.queue.push("run");
            }
          } else {
            session.status = "running";
            triggerTurnSimulation(session, "run", sseClients);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "queued", queue: session.queue }));
          return;
        }

        // Endpoint: POST /sessions/:id/interrupt
        const interruptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
        if (interruptMatch && req.method === "POST") {
          const sessionId = interruptMatch[1]!;
          const session = getOrCreateSession(sessionId);

          // Feature 4: Safe Execution Interruption
          session.queue = [];
          session.status = "idle";
          if (session.resolveRunning) {
            session.resolveRunning();
          }
          clearRunningSummaryCache(sessionId);
          if (session.wsClients.size === 0 && !session.cleanupTimer) {
            session.ptyBuffer = Buffer.alloc(0);
            sessions.delete(session.id);
          }

          // Broadcast state sync
          broadcastSSE(sseClients, {
            event: "SessionUpdated",
            workspaceId: sessionId,
            status: "idle",
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "idle" }));
          return;
        }

        // Endpoint: GET /sessions/:id/status
        const statusMatch = url.pathname.match(/^\/sessions\/([^/]+)\/status$/);
        if (statusMatch && req.method === "GET") {
          const sessionId = statusMatch[1]!;
          const session = getOrCreateSession(sessionId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: session.status }));
          return;
        }

        // Endpoint: POST /mock/event
        if (url.pathname === "/mock/event" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => { body += chunk; });
          req.on("end", () => {
            const eventData = JSON.parse(body);
            broadcastSSE(sseClients, eventData);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "broadcasted" }));
          });
          return;
        }

        // Endpoint: POST /mock/prompt (Feature 15 & 16 context verification)
        if (url.pathname === "/mock/prompt" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => { body += chunk; });
          req.on("end", () => {
            const payload = JSON.parse(body);
            // Simulate incremental context and history compaction check
            const containsContextUpdated = body.includes("ContextUpdated");
            const containsMarkdownSummary = body.includes("Goal") && body.includes("Constraints") && body.includes("Decisions");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              containsContextUpdated,
              containsMarkdownSummary,
              received: payload,
            }));
          });
          return;
        }

        // Endpoint: POST /server/stop
        if (url.pathname === "/server/stop" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "stopping" }));
          setImmediate(() => gracefulShutdown());
          return;
        }

        res.writeHead(404);
        res.end();
      });

      // WebSocket Server
      const wss = new WebSocketServer({ noServer: true });

      wss.on("connection", (ws: WebSocket, request: any) => {
        const wsUrl = new URL(request.url ?? "", `ws://${request.headers.host ?? "localhost"}`);
        const sessionId = wsUrl.pathname.match(/^\/pty\/([^/]+)/)?.[1] ?? "default";
        const session = getOrCreateSession(sessionId);
        session.wsClients.add(ws);

        // Feature 14: PTY Reconnection Resync with Cursor Buffer
        const cursorStr = wsUrl.searchParams.get("cursor");
        if (cursorStr !== null) {
          const cursor = parseInt(cursorStr, 10);
          if (!isNaN(cursor) && cursor < session.ptyBuffer.length) {
            const missingBytes = session.ptyBuffer.subarray(cursor);
            ws.send(missingBytes);
          }
        }

        ws.on("close", () => {
          session.wsClients.delete(ws);
          if (session.wsClients.size === 0) {
            if (session.cleanupTimer) {
              clearTimeout(session.cleanupTimer);
            }
            session.cleanupTimer = setTimeout(() => {
              session.ptyBuffer = Buffer.alloc(0);
              sessions.delete(session.id);
              clearRunningSummaryCache(session.id);
              delete session.cleanupTimer;
            }, 5000);
          }
        });
      });

      // Integrate WS upgrade
      server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "", `ws://${request.headers.host ?? "localhost"}`);
        
        // Authenticate WebSocket upgrade (Mutual authentication)
        const tokenQuery = url.searchParams.get("token");
        if (tokenQuery !== token) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        if (url.pathname.startsWith("/pty")) {
          wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
            wss.emit("connection", ws, request);
          });
        } else {
          socket.destroy();
        }
      });

      // Start Server on configured/random port
      const bindPort = parseInt(options.port, 10);
      server.listen(bindPort, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "string" ? 0 : (address?.port ?? 0);
        const url = `http://127.0.0.1:${port}`;

        // Write server.json
        const config = {
          url,
          pid: process.pid,
          version: "0.1.0",
          token,
        };
        writeFileSync(serverJsonPath, JSON.stringify(config, null, 2), "utf8");

        console.log(`Server started on ${url}`);
      });

      // Feature 9: Watch server.json to shut down gracefully if overridden
      let shutdownTimer = setInterval(() => {
        if (existsSync(serverJsonPath)) {
          try {
            const currentConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
            if (currentConfig.pid !== process.pid) {
              gracefulShutdown();
            }
          } catch {
            // Ignore parse errors
          }
        } else {
          // File deleted, shut down
          gracefulShutdown();
        }
      }, 1000);

      function gracefulShutdown() {
        clearInterval(shutdownTimer);
        server.close();
        wss.close();
        if (existsSync(serverJsonPath)) {
          try {
            const currentConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
            if (currentConfig.pid === process.pid) {
              unlinkSync(serverJsonPath);
            }
          } catch {}
        }
        process.exit(0);
      }

      // Register signal handlers for clean exit
      process.on("SIGTERM", gracefulShutdown);
      process.on("SIGINT", gracefulShutdown);
    });
}

function broadcastSSE(
  clients: Set<{ res: any; workspaceId?: string; directory?: string }>,
  eventData: any
) {
  for (const client of clients) {
    // Feature 10: SSE subscription yields workspace-isolated updates
    if (eventData.workspaceId && client.workspaceId && eventData.workspaceId !== client.workspaceId) {
      continue;
    }
    if (eventData.directory && client.directory && eventData.directory !== client.directory) {
      continue;
    }
    client.res.write(`data: ${JSON.stringify(eventData)}\n\n`);
  }
}

// Simulates real-time turn execution, EventBus events, and PTY stream
function triggerTurnSimulation(
  session: SessionState,
  triggerType: "run" | "wake",
  sseClients: any
) {
  session.runningPromise = (async () => {
    // Broadcast starting turn event via SSE
    broadcastSSE(sseClients, {
      event: "TurnStarted",
      workspaceId: session.id,
      triggerType,
    });

    // PTY output streaming simulation
    const streamPtyOutput = (text: string) => {
      const dataBuffer = Buffer.from(text);
      session.ptyBuffer = Buffer.concat([session.ptyBuffer, dataBuffer]);
      // Limit to 2MB
      if (session.ptyBuffer.length > PTY_BUFFER_SIZE) {
        session.ptyBuffer = session.ptyBuffer.subarray(session.ptyBuffer.length - PTY_BUFFER_SIZE);
      }
      // Stream to websocket clients (Feature 13)
      for (const ws of session.wsClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(dataBuffer);
        }
      }
    };

    // Run for a short time
    let steps = 4;
    for (let i = 0; i < steps; i++) {
      if (session.status !== "running") break;
      streamPtyOutput(`Step ${i + 1} processing turn...\n`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Process queue
    if (session.status === "running") {
      const nextType = session.queue.shift();
      if (nextType) {
        triggerTurnSimulation(session, nextType, sseClients);
      } else {
        session.status = "idle";
        broadcastSSE(sseClients, {
          event: "TurnCompleted",
          workspaceId: session.id,
          status: "idle",
        });
        clearRunningSummaryCache(session.id);
        if (session.wsClients.size === 0 && !session.cleanupTimer) {
          session.ptyBuffer = Buffer.alloc(0);
          sessions.delete(session.id);
        }
      }
    }
  })();
}
