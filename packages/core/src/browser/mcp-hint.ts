import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const BROWSER_MCP_SERVER = "cursor-ide-browser";

export const BROWSER_MCP_HINT =
  "Browser automation requires Cursor IDE Browser MCP. In Cursor: enable cursor-ide-browser MCP server.";

export interface BrowserMcpStatus {
  configured: boolean;
  hint: string;
}

function mentionsBrowserMcp(content: string): boolean {
  return content.includes(BROWSER_MCP_SERVER);
}

function checkMcpsFolder(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "mcps", BROWSER_MCP_SERVER));
}

function checkMcpJson(projectRoot: string): boolean {
  for (const folder of [".agency", ".cursor"]) {
    const mcpJson = join(projectRoot, folder, "mcp.json");
    if (existsSync(mcpJson)) {
      try {
        if (mentionsBrowserMcp(readFileSync(mcpJson, "utf8"))) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

function checkCursorMcpFolder(projectRoot: string): boolean {
  for (const folder of [".agency", ".cursor"]) {
    const mcpDir = join(projectRoot, folder, "mcp");
    if (!existsSync(mcpDir)) continue;

    try {
      for (const name of readdirSync(mcpDir)) {
        if (name.includes(BROWSER_MCP_SERVER)) return true;
        const full = join(mcpDir, name);
        try {
          const content = readFileSync(full, "utf8");
          if (mentionsBrowserMcp(content)) return true;
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // ignore
    }
  }

  return false;
}

export function getBrowserMcpStatus(projectRoot: string): BrowserMcpStatus {
  const configured =
    checkMcpsFolder(projectRoot) ||
    checkMcpJson(projectRoot) ||
    checkCursorMcpFolder(projectRoot);

  return {
    configured,
    hint: BROWSER_MCP_HINT,
  };
}
