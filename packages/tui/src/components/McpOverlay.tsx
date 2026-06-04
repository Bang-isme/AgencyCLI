import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadMcpConfigs, type McpServerStatus, EventBus } from "@agency/core";
import { readClipboard } from "../utils/clipboard.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";
import { applyTextInput } from "../hooks/useTextInput.js";
import { OverlayBox } from "./OverlayBox.js";
import { OverlayFooter } from "./OverlayFooter.js";

export interface McpOverlayProps {
  theme: ThemeTokens;
  projectRoot: string;
  connecting?: boolean;
  onClose: () => void;
  onReload: () => void;
}

type Phase =
  | "list"
  | "confirm_delete"
  | "add_select_template"
  | "configure_template"
  | "add_paste_name"
  | "add_paste_val"
  | "import_confirm_name"
  | "add_name"
  | "add_cmd"
  | "add_args"
  | "add_env"
  | "edit_select"
  | "edit_val";

function parsePastedConfig(input: string): { command: string; args: string[]; env?: Record<string, string> } | null {
  const clean = input.trim();
  if (!clean) return null;

  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(clean);
    // Case 1: Full mcpServers object, e.g. {"mcpServers": {"name": {...}}} or {"name": {"command": ...}}
    let mcpServers = parsed.mcpServers ?? parsed;
    const entries = Object.entries(mcpServers);
    if (entries.length > 0) {
      const [_, cfg] = entries[0] as [string, any];
      if (cfg && typeof cfg === "object" && typeof cfg.command === "string") {
        return {
          command: cfg.command,
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: cfg.env && typeof cfg.env === "object" ? cfg.env : {},
        };
      }
    }
    
    // Case 2: Single server config, e.g. {"command": "npx", "args": [...]}
    if (typeof parsed.command === "string") {
      return {
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args : [],
        env: parsed.env && typeof parsed.env === "object" ? parsed.env : {},
      };
    }
  } catch {}

  // Case 3: Raw command line string, e.g. "npx -y @upstash/context7-mcp --api-key xxx"
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === '"' || char === "'") {
      inQuotes = !inQuotes;
    } else if (char === " " && !inQuotes) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);

  if (parts.length > 0) {
    const command = parts[0]!;
    const args = parts.slice(1);
    // Extract any env vars prefixed like KEY=VAL
    const env: Record<string, string> = {};
    const filteredArgs: string[] = [];
    for (const arg of args) {
      if (arg.includes("=") && !arg.startsWith("-")) {
        const [k, v] = arg.split("=");
        if (k) env[k.trim()] = (v ?? "").trim();
      } else {
        filteredArgs.push(arg);
      }
    }
    return {
      command,
      args: filteredArgs,
      env,
    };
  }

  return null;
}

interface McpTemplate {
  id: string;
  name: string;
  desc: string;
  promptText: string;
  defaultVal: string;
  generator: (input: string) => { command: string; args: string[]; env?: Record<string, string> };
}

const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "context7",
    name: "Context7 Docs",
    desc: "Up-to-date version-specific docs & code examples",
    promptText: "Enter Context7 API Key (optional):",
    defaultVal: "",
    generator: (apiKey) => {
      return {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: apiKey.trim() ? {
          CONTEXT7_API_KEY: apiKey.trim(),
        } : undefined,
      };
    },
  },
  {
    id: "stitch",
    name: "StitchMCP Design",
    desc: "Figma design systems & screen integration",
    promptText: "Enter Stitch Project ID (optional):",
    defaultVal: "",
    generator: (projId) => {
      const args = ["-y", "stitch-mcp"];
      if (projId.trim()) {
        args.push("--project-id", projId.trim());
      }
      return {
        command: "npx",
        args,
      };
    },
  },
  {
    id: "filesystem",
    name: "Local Filesystem",
    desc: "Secure read/write access to project folders",
    promptText: "Enter Allowed Folder Path (e.g. D:\\MyFolder):",
    defaultVal: "",
    generator: (folderPath) => {
      return {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", folderPath.trim() || "."],
      };
    },
  },
  {
    id: "github",
    name: "GitHub API",
    desc: "Access issues, pull requests, and file search",
    promptText: "Enter GITHUB_TOKEN environment value:",
    defaultVal: "",
    generator: (token) => {
      return {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: {
          GITHUB_TOKEN: token.trim(),
        },
      };
    },
  },
  {
    id: "clipboard",
    name: "[Import from Clipboard]",
    desc: "Auto-detect and import server configuration from clipboard",
    promptText: "",
    defaultVal: "",
    generator: () => ({ command: "", args: [] }),
  },
  {
    id: "paste",
    name: "[Paste JSON / Command]",
    desc: "Type or paste JSON/command line manually step-by-step",
    promptText: "",
    defaultVal: "",
    generator: () => ({ command: "", args: [] }),
  },
  {
    id: "custom",
    name: "[Custom Server]",
    desc: "Set up a server manually step-by-step",
    promptText: "",
    defaultVal: "",
    generator: () => ({ command: "", args: [] }),
  },
];


export function McpOverlay({
  theme,
  projectRoot,
  connecting = false,
  onClose,
  onReload,
}: McpOverlayProps) {
  const { cols, rows } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 80, 45);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));
  const isSmallScreen = cols < 75;
  const leftPanelWidth = isSmallScreen ? "100%" : Math.min(32, Math.max(12, Math.floor(innerWidth * 0.4)));

  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("list");

  // Inputs buffers
  const [bufferName, setBufferName] = useState("");
  const [bufferCmd, setBufferCmd] = useState("");
  const [bufferArgs, setBufferArgs] = useState("");
  const [bufferEnv, setBufferEnv] = useState("");
  const [selectedEnvKeyIndex, setSelectedEnvKeyIndex] = useState(0);
  const [bufferEnvVal, setBufferEnvVal] = useState("");
  const [selectedTemplateIndex, setSelectedTemplateIndex] = useState(0);
  const [bufferTemplateParam, setBufferTemplateParam] = useState("");
  const [bufferPasteName, setBufferPasteName] = useState("");
  const [bufferPasteVal, setBufferPasteVal] = useState("");
  const [importError, setImportError] = useState("");
  const [pendingImportConfig, setPendingImportConfig] = useState<{ command: string; args: string[]; env?: Record<string, string> } | null>(null);
  const [notification, setNotification] = useState<{ type: "success" | "info" | "error"; text: string } | null>(null);

  const showNotification = (type: "success" | "info" | "error", text: string) => {
    setNotification({ type, text });
  };

  useEffect(() => {
    if (notification && notification.type !== "error") {
      const timer = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    const handleSystemWarning = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      const msgText = payload.message || "";

      if (msgText.includes("Successfully connected") || msgText.includes("MCP tools")) {
        const cleanMsg = msgText.replace("✓ ", "").replace("[MCP] ", "");
        showNotification("success", cleanMsg);
      } else if (msgText.includes("Error connecting to MCP Server")) {
        const cleanMsg = msgText.replace("❌ ", "").replace("[MCP] ", "").replace("⚠ ", "");
        showNotification("error", cleanMsg);
      }
    };

    EventBus.getInstance().subscribe("system:warning", handleSystemWarning);
    return () => {
      EventBus.getInstance().unsubscribe("system:warning", handleSystemWarning);
    };
  }, []);

  const refreshServers = () => {
    setServers(loadMcpConfigs(projectRoot));
  };

  useEffect(() => {
    refreshServers();
  }, [projectRoot]);

  const selectedServer = servers[selectedIndex];

  const updateConfig = (updater: (cfg: any) => any) => {
    const dir = join(projectRoot, ".agency");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const path = join(dir, "mcp.json");
    let cfg: any = { mcpServers: {} };
    if (existsSync(path)) {
      try {
        cfg = JSON.parse(readFileSync(path, "utf8"));
      } catch {}
    }
    if (!cfg.mcpServers) {
      cfg.mcpServers = {};
    }
    cfg = updater(cfg);
    writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
    refreshServers();
    onReload();
  };

  const stateRef = useRef({
    phase,
    selectedIndex,
    servers,
    selectedTemplateIndex,
    bufferTemplateParam,
    bufferPasteName,
    bufferPasteVal,
    pendingImportConfig,
    bufferName,
    bufferCmd,
    bufferArgs,
    bufferEnv,
    selectedEnvKeyIndex,
    bufferEnvVal,
    selectedServer,
    onClose,
    onReload,
    updateConfig,
    showNotification,
  });

  useEffect(() => {
    stateRef.current = {
      phase,
      selectedIndex,
      servers,
      selectedTemplateIndex,
      bufferTemplateParam,
      bufferPasteName,
      bufferPasteVal,
      pendingImportConfig,
      bufferName,
      bufferCmd,
      bufferArgs,
      bufferEnv,
      selectedEnvKeyIndex,
      bufferEnvVal,
      selectedServer,
      onClose,
      onReload,
      updateConfig,
      showNotification,
    };
  });

  useInput(
    useCallback((input, key) => {
      const {
        phase,
        selectedIndex: _selectedIndex,
        servers,
        selectedTemplateIndex,
        bufferTemplateParam,
        bufferPasteName,
        bufferPasteVal,
        pendingImportConfig,
        bufferName,
        bufferCmd,
        bufferArgs,
        bufferEnv,
        selectedEnvKeyIndex,
        bufferEnvVal,
        selectedServer,
        onClose,
        onReload: _onReload,
        updateConfig,
        showNotification,
      } = stateRef.current;
    const handleTextInput = (
      setter: React.Dispatch<React.SetStateAction<string>>,
      onReturn: () => void
    ) => {
      if (key.return) {
        onReturn();
        return;
      }
      applyTextInput(input, key, setter);
    };

    // ESC always returns to list (or closes overlay if in list)
    if (key.escape) {
      if (phase === "list") {
        onClose();
      } else if (
        phase === "add_select_template" ||
        phase === "add_paste_name" ||
        phase === "add_name" ||
        phase === "add_cmd" ||
        phase === "add_args" ||
        phase === "add_env" ||
        phase === "confirm_delete" ||
        phase === "edit_select"
      ) {
        setPhase("list");
      } else if (phase === "configure_template" || phase === "add_paste_val" || phase === "import_confirm_name") {
        setPhase("add_select_template");
      } else if (phase === "edit_val") {
        setPhase("edit_select");
      }
      return;
    }

    if (phase === "list") {
      if (key.upArrow) {
        setSelectedIndex((i) => (i === 0 ? Math.max(0, servers.length - 1) : i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => (i >= servers.length - 1 ? 0 : i + 1));
        return;
      }
      if (input === "a") {
        setSelectedTemplateIndex(0);
        setPhase("add_select_template");
        return;
      }
      if (input === "e" && selectedServer) {
        setSelectedEnvKeyIndex(0);
        setPhase("edit_select");
        return;
      }
      if (key.ctrl && input === "d" && selectedServer) {
        setPhase("confirm_delete");
        return;
      }
    }

    if (phase === "add_select_template") {
      if (key.upArrow || input === "k") {
        setSelectedTemplateIndex((i) => (i === 0 ? MCP_TEMPLATES.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedTemplateIndex((i) => (i >= MCP_TEMPLATES.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.return) {
        const t = MCP_TEMPLATES[selectedTemplateIndex];
        if (t) {
          if (t.id === "custom") {
            setBufferName("");
            setBufferCmd("");
            setBufferArgs("");
            setBufferEnv("");
            setPhase("add_name");
          } else if (t.id === "paste") {
            setBufferPasteName("");
            setBufferPasteVal("");
            setImportError("");
            setPhase("add_paste_name");
          } else if (t.id === "clipboard") {
            const clipText = readClipboard();
            const parsed = parsePastedConfig(clipText);
            if (!parsed) {
              showNotification("error", "Clipboard is empty or has no valid config.");
            } else {
              setPendingImportConfig(parsed);
              let defaultName = "imported-server";
              if (parsed.args && parsed.args.length > 0) {
                const pkgName = parsed.args.find((arg) => arg.includes("@") || arg.includes("mcp"));
                if (pkgName) {
                  const cleanName = pkgName.split("/").pop()?.replace("-mcp", "").replace("@", "");
                  if (cleanName) defaultName = cleanName;
                }
              }
              if (defaultName === "imported-server" && parsed.command) {
                defaultName = parsed.command;
              }
              setBufferPasteName(defaultName);
              setPhase("import_confirm_name");
            }
          } else {
            setBufferTemplateParam(t.defaultVal);
            setPhase("configure_template");
          }
        }
        return;
      }
      return;
    }

    if (phase === "configure_template") {
      const t = MCP_TEMPLATES[selectedTemplateIndex];
      if (!t) return;
      handleTextInput(setBufferTemplateParam, () => {
        const config = t.generator(bufferTemplateParam);
        updateConfig((cfg) => {
          cfg.mcpServers[t.name] = {
            command: config.command,
            args: config.args,
            env: config.env || {},
          };
          return cfg;
        });
        showNotification("success", `Server '${t.name}' added successfully!`);
        setPhase("list");
      });
      return;
    }

    if (phase === "add_paste_name") {
      handleTextInput(setBufferPasteName, () => {
        if (bufferPasteName.trim()) {
          setPhase("add_paste_val");
        }
      });
      return;
    }

    if (phase === "add_paste_val") {
      if (input) {
        setImportError("");
      }
      handleTextInput(setBufferPasteVal, () => {
        const parsed = parsePastedConfig(bufferPasteVal);
        if (!parsed) {
          setImportError("Invalid JSON or shell command.");
          return;
        }
        updateConfig((cfg) => {
          cfg.mcpServers[bufferPasteName.trim()] = {
            command: parsed.command,
            args: parsed.args,
            env: parsed.env || {},
          };
          return cfg;
        });
        showNotification("success", `Server '${bufferPasteName.trim()}' imported successfully!`);
        setPhase("list");
      });
      return;
    }

    if (phase === "import_confirm_name") {
      handleTextInput(setBufferPasteName, () => {
        const name = bufferPasteName.trim();
        if (name && pendingImportConfig) {
          updateConfig((cfg) => {
            cfg.mcpServers[name] = {
              command: pendingImportConfig.command,
              args: pendingImportConfig.args,
              env: pendingImportConfig.env || {},
            };
            return cfg;
          });
          setPendingImportConfig(null);
          showNotification("success", `Server '${name}' imported successfully!`);
          setPhase("list");
        }
      });
      return;
    }

    if (phase === "confirm_delete") {
      if (key.return && selectedServer) {
        const name = selectedServer.name;
        updateConfig((cfg) => {
          delete cfg.mcpServers[name];
          return cfg;
        });
        setSelectedIndex(0);
        showNotification("success", `Server '${name}' deleted successfully!`);
        setPhase("list");
      }
      return;
    }

    // Typing handlers for ADD flow
    if (phase === "add_name") {
      handleTextInput(setBufferName, () => {
        if (bufferName.trim()) {
          setPhase("add_cmd");
        }
      });
      return;
    }

    if (phase === "add_cmd") {
      handleTextInput(setBufferCmd, () => {
        if (bufferCmd.trim()) {
          setPhase("add_args");
        }
      });
      return;
    }

    if (phase === "add_args") {
      handleTextInput(setBufferArgs, () => {
        setPhase("add_env");
      });
      return;
    }

    if (phase === "add_env") {
      handleTextInput(setBufferEnv, () => {
        const name = bufferName.trim();
        const command = bufferCmd.trim();
        const rawArgs = bufferArgs.trim();
        const args = rawArgs ? rawArgs.split(/\s+/) : [];
        const env: Record<string, string> = {};

        // Parse key=val or just keys
        if (bufferEnv.trim()) {
          const parts = bufferEnv.split(",");
          for (const part of parts) {
            const [k, v] = part.split("=");
            if (k) env[k.trim()] = (v ?? "").trim();
          }
        }

        updateConfig((cfg) => {
          cfg.mcpServers[name] = { command, args, env };
          return cfg;
        });
        showNotification("success", `Server '${name}' added successfully!`);
        setPhase("list");
      });
      return;
    }

    // Typing handlers for EDIT flow
    if (phase === "edit_select") {
      const keys = selectedServer?.keys || [];
      if (keys.length === 0) {
        return;
      }
      if (key.upArrow) {
        setSelectedEnvKeyIndex((i) => (i === 0 ? keys.length - 1 : i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedEnvKeyIndex((i) => (i >= keys.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.return) {
        const target = keys[selectedEnvKeyIndex];
        if (target) {
          setBufferEnvVal(target.resolvedValue ?? "");
          setPhase("edit_val");
        }
        return;
      }
      return;
    }

    if (phase === "edit_val") {
      handleTextInput(setBufferEnvVal, () => {
        const keys = selectedServer?.keys || [];
        const target = keys[selectedEnvKeyIndex];
        if (target && selectedServer) {
          updateConfig((cfg) => {
            const server = cfg.mcpServers[selectedServer.name];
            if (server) {
              if (!server.env) server.env = {};
              server.env[target.key] = bufferEnvVal.trim();
            }
            return cfg;
          });
          showNotification("success", `Updated variable '${target.key}'!`);
        }
        setPhase("edit_select");
      });
      return;
    }
  }, [])
  );

  const safeSelectedIndex = Math.min(selectedIndex, servers.length - 1);
  const MAX_VISIBLE_SERVERS = 6;
  let startServer = 0;
  if (servers.length > MAX_VISIBLE_SERVERS) {
    startServer = Math.max(
      0,
      Math.min(safeSelectedIndex - Math.floor(MAX_VISIBLE_SERVERS / 2), servers.length - MAX_VISIBLE_SERVERS)
    );
  }
  const visibleServers = servers.slice(startServer, startServer + MAX_VISIBLE_SERVERS);

  const keys = selectedServer?.keys || [];
  const safeEnvIndex = Math.min(selectedEnvKeyIndex, keys.length - 1);
  const MAX_VISIBLE_KEYS = 6;
  let startEnv = 0;
  if (keys.length > MAX_VISIBLE_KEYS) {
    startEnv = Math.max(
      0,
      Math.min(safeEnvIndex - Math.floor(MAX_VISIBLE_KEYS / 2), keys.length - MAX_VISIBLE_KEYS)
    );
  }
  const visibleEnvKeys = keys.slice(startEnv, startEnv + MAX_VISIBLE_KEYS);

  const MAX_DETAIL_KEYS = 5;

  const visibleDetailKeys = selectedServer ? selectedServer.keys.slice(0, MAX_DETAIL_KEYS) : [];
  const remainingDetailKeysCount = selectedServer ? Math.max(0, selectedServer.keys.length - MAX_DETAIL_KEYS) : 0;

  const renderRightPanelContent = () => {
    if (phase === "list") {
      if (!selectedServer) {
        return (
          <Text color={theme.muted} italic wrap="wrap">
            Select a server to view details
          </Text>
        );
      }
      const fullCmd = [selectedServer.command, ...(selectedServer.args || [])].join(" ");
      return (
        <Box flexDirection="column" marginTop={0} overflow="hidden">
          <Text color={theme.muted} bold wrap="wrap">
            Details — {selectedServer.name}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.muted} wrap="wrap">
              Command: <Text color={theme.text} wrap="wrap">{fullCmd}</Text>
            </Text>
          </Box>
          <Text color={theme.muted} wrap="wrap">
            Source: <Text color={theme.muted} dimColor wrap="wrap">{selectedServer.sourcePath.split(/[\\/]/).pop()}</Text>
          </Text>
          <Box flexDirection="column" marginTop={1} overflow="hidden">
            <Text color={theme.muted} bold wrap="wrap">
              Environment Keys:
            </Text>
            {selectedServer.keys.length === 0 ? (
              <Text color={theme.muted} italic wrap="wrap">
                No env variables required (Uses CLI args)
              </Text>
            ) : (
              <Box flexDirection="column">
                {visibleDetailKeys.map((k) => (
                  <Text key={k.key} color={k.configured ? theme.success : theme.danger} wrap="wrap">
                    {k.configured ? "  ■ " : "  □ "}
                    <Text color={theme.text} wrap="wrap">{k.key}</Text>
                  </Text>
                ))}
                {remainingDetailKeysCount > 0 && (
                  <Text color={theme.muted} dimColor italic wrap="wrap">
                    {"  ... and " + remainingDetailKeysCount + " more"}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        </Box>
      );
    }

    if (phase === "confirm_delete") {
      if (!selectedServer) return null;
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.danger} bold wrap="wrap">
            ▲ DELETE SERVER
          </Text>
          <Box marginY={1} padding={1} borderStyle="single" borderColor={theme.danger} flexDirection="column" overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">
              Are you sure you want to delete '{selectedServer.name}'?
            </Text>
            <Box marginTop={1}>
              <Text color={theme.muted} wrap="wrap">
                This will permanently remove the server configuration from your mcp.json file.
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" marginTop={1} overflow="hidden">
            <Text color={theme.muted}>
              Press <Text color={theme.danger} bold>Enter</Text> to Delete  ·  <Text color={theme.muted} bold>Esc</Text> to Cancel
            </Text>
          </Box>
        </Box>
      );
    }

    if (phase === "add_select_template") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">
            Select Integration Template
          </Text>
          <Box flexDirection="column" marginY={1} overflow="hidden">
            {MCP_TEMPLATES.map((t, idx) => {
              const isSelected = idx === selectedTemplateIndex;
              return (
                <Box key={t.id} flexDirection="column" marginY={0}>
                  <Text wrap="wrap">
                    <Text color={isSelected ? theme.accent : theme.muted}>
                      {isSelected ? "▸ " : "  "}
                    </Text>
                    <Text color={isSelected ? theme.text : theme.muted} bold={isSelected}>
                      {t.name}
                    </Text>
                    <Text color={theme.muted}> - {t.desc}</Text>
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      );
    }

    if (phase === "configure_template") {
      const t = MCP_TEMPLATES[selectedTemplateIndex];
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">
            Configure {t?.name}
          </Text>
          <Box marginY={0}>
            <Text color={theme.muted} wrap="wrap">
              {t?.desc}
            </Text>
          </Box>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">
              {t?.promptText}
            </Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferTemplateParam || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
          <Box marginTop={0}>
            <Text color={theme.muted} italic wrap="wrap">
              Press Enter to save configuration, Esc to go back.
            </Text>
          </Box>
        </Box>
      );
    }

    if (phase === "add_paste_name") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">
            Import Config (Step 1/2)
          </Text>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">
              Enter Server Name:
            </Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferPasteName || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (phase === "add_paste_val") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">
            Import Config (Step 2/2) — {bufferPasteName}
          </Text>
          <Box marginY={0}>
            <Text color={theme.muted} wrap="wrap">
              Paste JSON config or shell command line here.
            </Text>
          </Box>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">
              Paste Config:
            </Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferPasteVal || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
          {importError ? (
            <Box marginTop={0}>
              <Text color={theme.danger} bold wrap="wrap">
                ❌ {importError}
              </Text>
            </Box>
          ) : (
            <Box marginTop={0}>
              <Text color={theme.muted} italic wrap="wrap">
                Press Enter to parse & save configuration.
              </Text>
            </Box>
          )}
        </Box>
      );
    }

    if (phase === "import_confirm_name") {
      const fullCmd = pendingImportConfig ? [pendingImportConfig.command, ...(pendingImportConfig.args || [])].join(" ") : "";
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">
            📥 Import Config from Clipboard
          </Text>
          <Box marginY={0} flexDirection="column" overflow="hidden">
            <Text color={theme.muted} wrap="wrap">
              Found command: <Text color={theme.text} wrap="wrap">{fullCmd}</Text>
            </Text>
          </Box>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">
              Enter name for this server:
            </Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferPasteName || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
          <Box marginTop={0}>
            <Text color={theme.muted} italic wrap="wrap">
              Press Enter to save configuration, Esc to cancel.
            </Text>
          </Box>
        </Box>
      );
    }

    if (phase === "add_name") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">Custom Server Setup (Step 1/4)</Text>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">Enter Server Name:</Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferName || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (phase === "add_cmd") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">Custom Server Setup (Step 2/4) — {bufferName}</Text>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">Enter Command (e.g. node, python, npx):</Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferCmd || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (phase === "add_args") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">Custom Server Setup (Step 3/4)</Text>
          <Text color={theme.muted} wrap="wrap">Name: {bufferName} · Command: {bufferCmd}</Text>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">Enter Arguments (space-separated):</Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferArgs || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (phase === "add_env") {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="wrap">Custom Server Setup (Step 4/4)</Text>
          <Text color={theme.muted} wrap="wrap">Name: {bufferName} · Command: {bufferCmd} · Args: {bufferArgs}</Text>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="wrap">Enter Env Variables (comma-separated: K1=V1,K2=V2):</Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">{bufferEnv || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (phase === "edit_select") {
      const keys = selectedServer?.keys || [];
      if (keys.length === 0) {
        return (
          <Box flexDirection="column" overflow="hidden">
            <Text color={theme.accent} bold wrap="truncate">
              Select Env Variable to Edit:
            </Text>
            <Box marginY={0}>
              <Text color={theme.muted} italic wrap="wrap">
                No environment variables required for this server.
              </Text>
              <Box marginTop={0}>
                <Text color={theme.muted} wrap="wrap">
                  This server runs using command-line arguments instead of environment variables.
                </Text>
              </Box>
            </Box>
            <Box marginTop={0}>
              <Text color={theme.muted} dimColor wrap="truncate">
                Esc to go back
              </Text>
            </Box>
          </Box>
        );
      }
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="truncate">
            Select Env Variable to Edit:
          </Text>
          <Box flexDirection="column" marginY={0} overflow="hidden">
            {startEnv > 0 && (
              <Text color={theme.muted} dimColor wrap="truncate">
                ▲ ...
              </Text>
            )}
            {visibleEnvKeys.map((k, idx) => {
              const realIdx = startEnv + idx;
              const isSelected = realIdx === safeEnvIndex;
              const valLimit = Math.max(10, innerWidth - k.key.length - 12);
              return (
                <Box key={k.key} height={1} overflow="hidden">
                  <Text wrap="truncate">
                    <Text color={isSelected ? theme.accent : theme.muted}>
                      {isSelected ? "▸ " : "  "}
                    </Text>
                    <Text color={theme.text} bold={isSelected}>
                      {k.key}
                    </Text>
                    <Text color={theme.muted}> = </Text>
                    <Text color={k.configured ? theme.success : theme.warning}>
                      {k.configured ? (k.resolvedValue?.slice(0, valLimit) || "configured") : "unset"}
                    </Text>
                  </Text>
                </Box>
              );
            })}
            {startEnv + MAX_VISIBLE_KEYS < keys.length && (
              <Text color={theme.muted} dimColor wrap="truncate">
                ▼ ...
              </Text>
            )}
          </Box>
          <Text color={theme.muted} dimColor wrap="truncate">
            ↑↓ select · Enter edit value · Esc back
          </Text>
        </Box>
      );
    }

    if (phase === "edit_val") {
      const targetKey = keys[selectedEnvKeyIndex]?.key;
      return (
        <Box flexDirection="column" overflow="hidden">
          <Text color={theme.accent} bold wrap="truncate">
            Edit Environment Variable
          </Text>
          <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginY={0} overflow="hidden">
            <Text color={theme.text} bold wrap="truncate">
              Enter value for {targetKey}:
            </Text>
            <Box flexDirection="row" marginTop={0} overflow="hidden">
              <Text color={theme.accent} bold wrap="truncate">{bufferEnvVal || " "}</Text>
              <Text color={theme.accent}>|</Text>
            </Box>
          </Box>
          <Box marginTop={0}>
            <Text color={theme.muted} italic wrap="wrap">
              Values starting with $ (e.g. $API_KEY) will resolve from system env variables.
            </Text>
          </Box>
        </Box>
      );
    }

    return null;
  };

  return (
    <OverlayBox
      theme={theme}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      width={overlayWidth}
    >
      {/* Title */}
      <Box flexDirection="row" justifyContent="space-between" width={innerWidth} height={1} overflow="hidden">
        <Text color={theme.text} bold>
          🔌 MCP Server Configurator
        </Text>
        {connecting && (
          <Text color={theme.warning}>
            ⌛ Connecting servers...
          </Text>
        )}
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection={isSmallScreen ? "column" : "row"} height={isSmallScreen ? undefined : Math.max(4, Math.min(12, rows - 12 - (notification ? 3 : 0)))} marginY={1}>
        {/* Left panel: List */}
        <Box flexDirection="column" width={leftPanelWidth} borderStyle="single" borderColor={theme.dimBorder} paddingX={1} height={isSmallScreen ? Math.max(4, Math.min(6, rows - 16)) : undefined}>
          <Text color={theme.muted} bold wrap="wrap">
            Servers
          </Text>
          {servers.length === 0 ? (
            <Text color={theme.muted} italic wrap="wrap">
              No servers loaded
            </Text>
          ) : (
            <Box flexDirection="column" overflow="hidden">
              {startServer > 0 && (
                <Text color={theme.muted} dimColor wrap="wrap">
                  ▲ ...
                </Text>
              )}
              {visibleServers.map((s, idx) => {
                const realIdx = startServer + idx;
                const isSelected = realIdx === safeSelectedIndex;
                const isConf = s.configured;
                return (
                  <Box key={s.name} height={1} overflow="hidden">
                    <Text wrap="wrap">
                      <Text color={isSelected ? theme.accent : theme.muted}>
                        {isSelected ? "▸ " : "  "}
                      </Text>
                      <Text color={isConf ? theme.success : theme.danger}>
                        {isConf ? "■ " : "□ "}
                      </Text>
                      <Text color={isSelected ? theme.text : theme.muted} bold={isSelected}>
                        {s.name}
                      </Text>
                    </Text>
                  </Box>
                );
              })}
              {startServer + MAX_VISIBLE_SERVERS < servers.length && (
                <Text color={theme.muted} dimColor wrap="wrap">
                  ▼ ...
                </Text>
              )}
            </Box>
          )}
        </Box>

        {/* Right panel: Workspace */}
        <Box flexDirection="column" flexGrow={1} width={isSmallScreen ? "100%" : undefined} borderStyle="single" borderColor={theme.dimBorder} paddingX={1} marginLeft={isSmallScreen ? 0 : 1} marginTop={isSmallScreen ? 1 : 0} overflow="hidden">
          {renderRightPanelContent()}
        </Box>
      </Box>

      {notification && (
        <Box paddingX={1} marginY={0} height={3} borderStyle="single" borderColor={notification.type === "success" ? theme.success : notification.type === "error" ? theme.danger : theme.accent} overflow="hidden">
          <Text color={notification.type === "success" ? theme.success : notification.type === "error" ? theme.danger : theme.text} wrap="wrap">
            {notification.type === "success" ? "✔ " : notification.type === "error" ? "✖ " : "ℹ "}
            {notification.text}
          </Text>
        </Box>
      )}

      <OverlayFooter
        theme={theme}
        actions={
          phase === "list"
            ? innerWidth >= 65
              ? ["↑↓ navigate", "a add", "e edit env", "Ctrl+d delete", "Esc close"]
              : innerWidth >= 48
              ? ["↑↓ nav", "a add", "e edit", "Ctrl+d del", "Esc close"]
              : ["↑↓:nav", "a:add", "e:edit", "C-d:del", "Esc:close"]
            : phase === "add_select_template"
            ? innerWidth >= 55
              ? ["↑↓ select template", "Enter select", "Esc cancel"]
              : ["↑↓:select", "Enter:select", "Esc:cancel"]
            : phase === "edit_select"
            ? innerWidth >= 50
              ? ["↑↓ select", "Enter change value", "Esc back"]
              : ["↑↓:select", "Enter:change", "Esc:back"]
            : innerWidth >= 45
            ? ["Enter confirm", "Esc cancel"]
            : ["Enter:ok", "Esc:esc"]
        }
      />
    </OverlayBox>
  );
}
