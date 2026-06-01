import { createServer, request, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket, isIP } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EgressFilterProxyOptions {
  projectRoot: string;
  onSecurityAlert?: (event: { action: string; payload: any }) => void;
}

export function matchGlob(domain: string, pattern: string): boolean {
  if (domain.toLowerCase() === pattern.toLowerCase()) {
    return true;
  }
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2).toLowerCase();
    return domain.toLowerCase() === base || domain.toLowerCase().endsWith("." + base);
  }
  return false;
}

export class EgressFilterProxy {
  private server: Server;
  private port: number | null = null;
  private whitelist: string[] = [];
  private blockCounts = new Map<string, number>();
  private blockTimers = new Map<string, NodeJS.Timeout>();

  constructor(private options: EgressFilterProxyOptions) {
    this.loadWhitelist();
    this.server = createServer();
    this.setupListeners();
  }

  private loadWhitelist() {
    const defaultWhitelist = [
      // LLMs
      "*.openai.com",
      "*.anthropic.com",
      "*.googleapis.com",
      "api.deepseek.com",
      "*.nvidia.com",
      "*.groq.com",
      "*.cohere.com",
      "*.ollama.com",
      "localhost",
      "127.0.0.1",
      // Registries / Dev Tools
      "*.npmjs.org",
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "*.cargo.io",
      "github.com",
      "*.github.com",
      // Common web assets — Google Fonts serves its CSS from fonts.googleapis.com
      // (already covered by *.googleapis.com) and the font binaries it references
      // from fonts.gstatic.com. Allowing only the former left every generated page
      // that uses Google Fonts half-loaded plus an alarming egress "SECURITY
      // WARNING"; pairing the two removes that false positive for a ubiquitous,
      // reputable dev resource without broadening egress generally.
      "fonts.gstatic.com",
      // Ubiquitous, reputable, read-only dev CDNs (static JS/CSS/asset hosting).
      // A coding agent that scaffolds web apps routinely references these; blocking
      // them produced the same half-loaded-page + scary "SECURITY WARNING" the
      // Google Fonts case did. They serve GET-only static assets (no data-storing
      // endpoint), so the exfiltration risk this proxy guards against is minimal.
      // Specific hosts, not broad wildcards; per-project needs go in
      // .agency/security/egress-whitelist.json.
      "cdn.jsdelivr.net",
      "unpkg.com",
      "cdnjs.cloudflare.com",
      "esm.sh"
    ];

    const whitelistPath = join(this.options.projectRoot, ".agency", "security", "egress-whitelist.json");
    if (existsSync(whitelistPath)) {
      try {
        const fileContent = readFileSync(whitelistPath, "utf8");
        const custom = JSON.parse(fileContent);
        if (Array.isArray(custom)) {
          this.whitelist = [...new Set([...defaultWhitelist, ...custom])];
          return;
        }
      } catch {
        // Fallback to default
      }
    }
    this.whitelist = defaultWhitelist;
  }

  private isAllowed(target: string): boolean {
    const host = target.split(":")[0]?.trim().toLowerCase();
    if (!host) return false;

    // Direct IP blocking rule: Reject all raw IP socket calls to prevent SNI bypass
    if (isIP(host) !== 0) {
      // Loopback is whitelisted explicitly
      if (host === "127.0.0.1" || host === "::1") {
        return true;
      }
      return false;
    }

    return this.whitelist.some((pattern) => matchGlob(host, pattern));
  }

  private reportBlock(domain: string) {
    const host = domain.split(":")[0]?.trim().toLowerCase() || domain;
    
    // Check sliding window
    if (this.blockTimers.has(host)) {
      const current = this.blockCounts.get(host) || 0;
      this.blockCounts.set(host, current + 1);
      return;
    }

    // Trigger immediate alert for the first failure
    this.options.onSecurityAlert?.({
      action: "security:egress-denied",
      payload: {
        domain: host,
        count: 1,
        message: `Blocked unauthorized connection attempt to: ${host}`
      }
    });

    // Set 5-second sliding window timer
    const timer = setTimeout(() => {
      const count = this.blockCounts.get(host) || 0;
      if (count > 0) {
        this.options.onSecurityAlert?.({
          action: "security:egress-denied",
          payload: {
            domain: host,
            count: count + 1,
            message: `Blocked ${count + 1} unauthorized connection attempts to: ${host} (aggregated)`
          }
        });
      }
      this.blockCounts.delete(host);
      this.blockTimers.delete(host);
    }, 5000);

    this.blockTimers.set(host, timer);
    this.blockCounts.set(host, 0);
  }

  private setupListeners() {
    // 1. Resilient HTTP request handler
    this.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      try {
        const target = req.headers.host || "";
        if (!this.isAllowed(target)) {
          this.reportBlock(target);
          res.statusCode = 403;
          res.setHeader("Content-Type", "text/plain");
          res.end("403 Forbidden: Destination not whitelisted in secure sandbox.");
          return;
        }

        // Standard HTTP forwarding proxy
        const urlObj = new URL(req.url || "", `http://${target}`);
        const forwardReq = request({
          host: urlObj.hostname,
          port: Number(urlObj.port) || 80,
          method: req.method,
          path: urlObj.pathname + urlObj.search,
          headers: req.headers
        }, (forwardRes) => {
          res.writeHead(forwardRes.statusCode || 200, forwardRes.headers);
          forwardRes.pipe(res);
        });

        req.pipe(forwardReq);

        forwardReq.on("error", (err) => {
          try {
            res.statusCode = 502;
            res.end(`Bad Gateway: ${err.message}`);
          } catch {
            // ignore
          }
        });
      } catch (err) {
        try {
          res.statusCode = 500;
          res.end(`Internal Proxy Error: ${err instanceof Error ? err.message : String(err)}`);
        } catch {
          // ignore
        }
      }
    });

    // 2. Resilient HTTPS CONNECT tunnel handler
    this.server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      const target = req.url || "";
      
      // Resilient error handlers for client socket
      clientSocket.on("error", () => {
        try { clientSocket.destroy(); } catch {}
      });

      if (!this.isAllowed(target)) {
        this.reportBlock(target);
        try {
          clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n403 Forbidden: Destination not whitelisted in secure sandbox.\r\n");
          clientSocket.end();
        } catch {
          try { clientSocket.destroy(); } catch {}
        }
        return;
      }

      const parts = target.split(":");
      const host = parts[0]?.trim();
      const port = Number(parts[1]) || 443;

      if (!host) {
        try {
          clientSocket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          clientSocket.end();
        } catch {
          try { clientSocket.destroy(); } catch {}
        }
        return;
      }

      // Establish CONNECT tunnel tunnel stream
      try {
        const serverSocket = connect({ host, port }, () => {
          try {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head && head.length > 0) {
              serverSocket.write(head);
            }
            clientSocket.pipe(serverSocket);
            serverSocket.pipe(clientSocket);
          } catch (err) {
            try { clientSocket.destroy(); } catch {}
            try { serverSocket.destroy(); } catch {}
          }
        });

        // Resilient error handlers for server socket
        serverSocket.on("error", () => {
          try {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            clientSocket.end();
          } catch {}
          try { serverSocket.destroy(); } catch {}
        });

        serverSocket.on("close", () => {
          try { clientSocket.destroy(); } catch {}
        });

        clientSocket.on("close", () => {
          try { serverSocket.destroy(); } catch {}
        });
      } catch (err) {
        try {
          clientSocket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
          clientSocket.end();
        } catch {}
      }
    });

    // Catch general server errors to avoid crashing Node process
    this.server.on("error", () => {
      // ignore, dynamic port try-catch takes care of starting listener
    });
  }

  public async start(): Promise<number> {
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
      try {
        attempts++;
        await new Promise<void>((resolve, reject) => {
          this.server.listen(0, "127.0.0.1", () => {
            const addr = this.server.address();
            if (addr && typeof addr === "object") {
              this.port = addr.port;
              resolve();
            } else {
              reject(new Error("Failed to retrieve port"));
            }
          });
          this.server.once("error", (err) => {
            reject(err);
          });
        });
        return this.port!;
      } catch (err) {
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to bind EgressFilterProxy to an ephemeral port after ${maxAttempts} attempts: ${err instanceof Error ? err.message : String(err)}`);
        }
        // retry on next loop iteration
      }
    }
    throw new Error("Failed to start proxy");
  }

  public async stop(): Promise<void> {
    // Clear all active timers
    for (const timer of this.blockTimers.values()) {
      clearTimeout(timer);
    }
    this.blockTimers.clear();
    this.blockCounts.clear();

    return new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  public getPort(): number | null {
    return this.port;
  }
}
