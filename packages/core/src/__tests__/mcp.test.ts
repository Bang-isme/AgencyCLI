import { describe, it, expect } from "vitest";
import { loadMcpConfigs } from "../mcp/config.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadMcpConfigs", () => {
  it("returns empty array when no mcp.json files exist", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const configs = loadMcpConfigs(tempDir);
    expect(configs).toEqual([]);
  });

  it("loads and parses local mcp.json successfully", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    mkdirSync(join(tempDir, ".agency"), { recursive: true });

    const mcpData = {
      mcpServers: {
        StitchMCP: {
          command: "node",
          args: ["stitch.js"],
          env: {
            STITCH_API_KEY: "direct-value",
            STITCH_SECRET: "${STITCH_SECRET_ENV_VAR}",
          },
        },
      },
    };

    writeFileSync(
      join(tempDir, ".agency", "mcp.json"),
      JSON.stringify(mcpData, null, 2)
    );

    // Set the environment variable for testing resolution
    process.env.STITCH_SECRET_ENV_VAR = "secret-value";

    try {
      const configs = loadMcpConfigs(tempDir);
      expect(configs).toHaveLength(1);
      const server = configs[0]!;
      expect(server.name).toBe("StitchMCP");
      expect(server.configured).toBe(true);
      expect(server.keys).toHaveLength(2);
      expect(server.keys.find((k) => k.key === "STITCH_API_KEY")?.configured).toBe(true);
      expect(server.keys.find((k) => k.key === "STITCH_SECRET")?.resolvedValue).toBe("secret-value");
    } finally {
      delete process.env.STITCH_SECRET_ENV_VAR;
    }
  });

  it("marks as not configured if environment variable is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    mkdirSync(join(tempDir, ".agency"), { recursive: true });

    const mcpData = {
      mcpServers: {
        context7: {
          command: "node",
          args: ["context.js"],
          env: {
            CONTEXT_API_KEY: "${MISSING_KEY_VAR}",
          },
        },
      },
    };

    writeFileSync(
      join(tempDir, ".agency", "mcp.json"),
      JSON.stringify(mcpData, null, 2)
    );

    const configs = loadMcpConfigs(tempDir);
    expect(configs).toHaveLength(1);
    const server = configs[0]!;
    expect(server.name).toBe("context7");
    expect(server.configured).toBe(false);
    expect(server.keys[0]?.configured).toBe(false);
  });
});
