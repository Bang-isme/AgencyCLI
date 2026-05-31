import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { loadMcpConfigs } from "./config.js";
import { registry as toolRegistry } from "../skill/tool-harness.js";
import { z } from "zod";
import { EventBus } from "../events/event-bus.js";
import { getRuntimeFlags } from "../runtime/flags.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export class McpClient {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void; timer?: NodeJS.Timeout }>();
  private tools: McpToolDefinition[] = [];

  constructor(
    public readonly name: string,
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {}
  ) {}

  public async start(): Promise<void> {
    const envMerged = {
      ...process.env,
      ...this.env,
    };

    this.process = spawn(this.command, this.args, {
      env: envMerged,
      stdio: ["pipe", "pipe", "inherit"],
      shell: true,
    });

    this.process.on("error", (err) => {
      console.error(`[MCP Client ${this.name}] Failed to start process:`, err);
    });

    this.rl = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      this.handleLine(line);
    });

    this.process.on("exit", (code, signal) => {
      // Reject any pending requests
      for (const [, promise] of this.pendingRequests.entries()) {
        if (promise.timer) clearTimeout(promise.timer);
        promise.reject(new Error(`MCP server ${this.name} exited with code ${code} and signal ${signal}`));
      }
      this.pendingRequests.clear();
      this.process = null;
    });

    // Perform JSON-RPC handshake
    await this.initialize();
  }

  public async shutdown(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      this.process.kill("SIGTERM");
      const proc = this.process;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, 1000);
        proc.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.process = null;
    }
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc !== "2.0") return;

      if (msg.id !== undefined && msg.id !== null) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          if (pending.timer) clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || "MCP JSON-RPC Error"));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // Ignore malformed JSON lines
    }
  }

  private request<T>(method: string, params: any = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(new Error(`MCP server ${this.name} is not running.`));
      }

      const id = this.nextId++;
      const msg = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      // Bound each request so a hung/unresponsive server can't accumulate
      // pending promises forever (memory leak + stalled execution).
      const timeoutMs = getRuntimeFlags().mcpRequestTimeoutMs;
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`MCP server ${this.name} request "${method}" timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        timer.unref?.();
      }

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  private sendNotification(method: string, params: any = {}): void {
    if (!this.process || !this.process.stdin) return;

    const msg = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "agency-cli-core",
        version: "1.0.0",
      },
    });

    this.sendNotification("notifications/initialized");
  }

  public async listTools(): Promise<McpToolDefinition[]> {
    try {
      const response = await this.request<{ tools: McpToolDefinition[] }>("tools/list");
      this.tools = response.tools || [];
      return this.tools;
    } catch (err) {
      console.error(`[MCP Client ${this.name}] Failed to list tools:`, err);
      return [];
    }
  }

  public async callTool(name: string, args: Record<string, any>): Promise<any> {
    try {
      const response = await this.request<any>("tools/call", {
        name,
        arguments: args,
      });
      return response;
    } catch (err: any) {
      throw new Error(`MCP Tool call failed: ${err.message || String(err)}`);
    }
  }
}

export const activeMcpClients = new Map<string, McpClient>();

export async function initializeMcpServers(projectRoot: string): Promise<void> {
  // Shutdown existing servers first to guarantee clean slate
  await shutdownMcpServers();

  const configs = loadMcpConfigs(projectRoot);
  const activeConfigs = configs.filter((c) => c.configured);

  if (activeConfigs.length === 0) {
    return;
  }

  void EventBus.getInstance().publish("system:warning", {
    message: `🔌 [MCP] Initializing MCP Server system (${activeConfigs.length} servers)...`,
  });

  let totalToolsRegistered = 0;

  for (const config of activeConfigs) {
    const envRecord: Record<string, string> = {};
    for (const keyInfo of config.keys) {
      if (keyInfo.configured && keyInfo.resolvedValue) {
        envRecord[keyInfo.key] = keyInfo.resolvedValue;
      }
    }

    const client = new McpClient(config.name, config.command, config.args || [], envRecord);
    try {
      await client.start();
      const tools = await client.listTools();
      
      for (const tool of tools) {
        const fullToolName = `${config.name.toLowerCase()}_${tool.name}`;
        
        // Dynamically register the tool to toolRegistry
        toolRegistry.register({
          name: fullToolName,
          description: tool.description || `MCP Tool '${tool.name}' from ${config.name}`,
          category: "other",
          schema: z.record(z.any()), // Zod lenient validation to bypass strict validation in CLI layer
          execute: async (args: any) => {
            const result = await client.callTool(tool.name, args);
            // Handle standard MCP text/image results
            if (result && Array.isArray(result.content)) {
              return result.content
                .map((c: any) => {
                  if (c.type === "text") return c.text;
                  if (c.type === "image") return `[Image: ${c.mimeType || "raw"}]`;
                  return JSON.stringify(c);
                })
                .join("\n");
            }
            return JSON.stringify(result);
          },
          // Attach custom property so we can resolve parameter details in prompts
          mcpSchema: tool.inputSchema,
        } as any);

        totalToolsRegistered++;
      }

      activeMcpClients.set(config.name, client);
    } catch (err: any) {
      console.error(`[MCP] Failed to startup or retrieve tools from server ${config.name}:`, err);
      void EventBus.getInstance().publish("system:warning", {
        message: `❌ [MCP] Error connecting to MCP Server '${config.name}': ${err.message || String(err)}`,
      });
      await client.shutdown();
    }
  }

  if (totalToolsRegistered > 0) {
    void EventBus.getInstance().publish("system:warning", {
      message: `✓ [MCP] Successfully connected and registered ${totalToolsRegistered} extension tools.`,
    });
  }
}

export async function shutdownMcpServers(): Promise<void> {
  for (const [name, client] of activeMcpClients.entries()) {
    try {
      await client.shutdown();
    } catch (err) {
      console.error(`Failed to shutdown MCP server ${name}:`, err);
    }
  }
  activeMcpClients.clear();
}
