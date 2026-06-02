import { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { ProviderId, ProviderProfile } from "@agency/providers";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";
import { deleteLastGrapheme } from "../utils/text.js";

export interface ConnectOverlayProps {
  theme: ThemeTokens;
  providers: ProviderStatus[];
  onSelect?: (providerId: ProviderId) => void;
  onSaveKey: (providerId: ProviderId, apiKey: string, extraProfile?: Partial<ProviderProfile>) => void;
  onClose: () => void;
  profiles?: Partial<Record<ProviderId, ProviderProfile>>;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  icon: string;
  configured: boolean;
  modelCount?: number;
}

const PROVIDER_INFO: Record<string, { label: string; icon: string }> = {
  nvidia: { label: "NVIDIA NIM", icon: "🔌" },
  openrouter: { label: "OpenRouter", icon: "🌐" },
  google: { label: "Google Gemini", icon: "💎" },
  openai: { label: "OpenAI", icon: "🤖" },
  anthropic: { label: "Anthropic", icon: "🔮" },
  local: { label: "Local (Ollama)", icon: "🖥" },
};

export function getProviderInfo(id: string): { label: string; icon: string } {
  return PROVIDER_INFO[id] ?? { label: id, icon: "·" };
}

type Phase = "list" | "menu" | "input" | "confirm_disconnect";

export function ConnectOverlay({
  theme,
  providers,
  onSelect,
  onSaveKey,
  onClose,
  profiles,
}: ConnectOverlayProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 72, 40);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("list");
  const [keyBuffer, setKeyBuffer] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [confirmIndex, setConfirmIndex] = useState(0);

  const [localStep, setLocalStep] = useState<"baseUrl" | "model" | "apiKey">("baseUrl");
  const [localBaseUrl, setLocalBaseUrl] = useState("");
  const [localModel, setLocalModel] = useState("");

  const safe = providers.length === 0 ? 0 : index % providers.length;
  const selected = providers[safe];

  const stateRef = useRef({
    phase,
    index,
    providers,
    keyBuffer,
    menuIndex,
    confirmIndex,
    localStep,
    localBaseUrl,
    localModel,
    selected,
    onSaveKey,
    onClose,
    onSelect,
    profiles,
  });

  useEffect(() => {
    stateRef.current = {
      phase,
      index,
      providers,
      keyBuffer,
      menuIndex,
      confirmIndex,
      localStep,
      localBaseUrl,
      localModel,
      selected,
      onSaveKey,
      onClose,
      onSelect,
      profiles,
    };
  });

  useInput(
    useCallback((input, key) => {
      const {
        phase,
        index,
        providers,
        keyBuffer,
        menuIndex,
        confirmIndex,
        localStep,
        localBaseUrl,
        localModel,
        selected,
        onSaveKey,
        onClose,
        onSelect,
        profiles,
      } = stateRef.current;
    if (phase === "input") {
      if (key.escape) {
        if (selected?.id === "local") {
          if (localStep === "apiKey") {
            setLocalStep("model");
            setKeyBuffer(localModel);
            return;
          }
          if (localStep === "model") {
            setLocalStep("baseUrl");
            setKeyBuffer(localBaseUrl);
            return;
          }
        }
        setPhase(selected?.configured ? "menu" : "list");
        setKeyBuffer("");
        return;
      }
      if (key.return) {
        if (selected?.id === "local") {
          if (localStep === "baseUrl") {
            const val = keyBuffer.trim() || profiles?.local?.baseUrl || "http://localhost:11434/v1";
            setLocalBaseUrl(val);
            setLocalStep("model");
            setKeyBuffer(profiles?.local?.model ?? "llama3.2");
            return;
          }
          if (localStep === "model") {
            const val = keyBuffer.trim() || profiles?.local?.model || "llama3.2";
            setLocalModel(val);
            setLocalStep("apiKey");
            setKeyBuffer(profiles?.local?.apiKey ?? "");
            return;
          }
          if (localStep === "apiKey") {
            const val = keyBuffer.trim();
            onSaveKey(selected.id, val, {
              baseUrl: localBaseUrl,
              model: localModel,
            });
            setPhase("list");
            setKeyBuffer("");
            return;
          }
        } else {
          if (keyBuffer.trim() && selected) {
            onSaveKey(selected.id, keyBuffer.trim());
          }
          setPhase("list");
          setKeyBuffer("");
          return;
        }
      }
      // Handle physical backspace/delete/Ctrl+H explicitly first
      const isCtrlH = key.ctrl && (input === "h" || (key as any).name === "h");
      const isBackspaceOrDelete = key.backspace || key.delete || isCtrlH;

      if (isBackspaceOrDelete) {
        setKeyBuffer((b) => deleteLastGrapheme(b));
        return;
      }

      // Handle escape sequences
      if (input.includes("\x1b")) {
        if (key.escape) {
          // Ignored or handled elsewhere
        }
        return;
      }

      // Handle control shortcuts (e.g. Ctrl+A, Ctrl+Z, etc.), excluding backspace/delete codes
      const isControlShortcut =
        (key.ctrl || key.meta) &&
        (!input ||
          (/^[a-zA-Z]$/.test(input) && input !== "h") ||
          (input.length > 0 &&
            input.charCodeAt(0) < 32 &&
            input.charCodeAt(0) !== 8 &&
            input.charCodeAt(0) !== 127));

      if (isControlShortcut || key.escape) {
        return;
      }

      // Default/Fall-through: process any typed characters (including IME chunks and fallback backspaces)
      if (input) {
        for (let i = 0; i < input.length; i++) {
          const char = input[i];
          const isCharBackspace =
            char === "\b" ||
            char === "\x08" ||
            char === "\x7f";

          if (isCharBackspace) {
            setKeyBuffer((b) => deleteLastGrapheme(b));
          } else {
            const cleaned = char.replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\uFEFF]/g, "");
            if (cleaned) {
              setKeyBuffer((b) => b + cleaned);
            }
          }
        }
      }
      return;
    }

    if (phase === "menu") {
      if (key.escape) {
        setPhase("list");
        return;
      }
      if (key.upArrow) {
        setMenuIndex((i) => (i === 0 ? 2 : i - 1));
        return;
      }
      if (key.downArrow) {
        setMenuIndex((i) => (i === 2 ? 0 : i + 1));
        return;
      }
      if (key.return && selected) {
        if (menuIndex === 0) {
          setPhase("input");
          if (selected.id === "local") {
            setLocalStep("baseUrl");
            setKeyBuffer(profiles?.local?.baseUrl ?? "http://localhost:11434/v1");
          } else {
            setKeyBuffer("");
          }
        } else if (menuIndex === 1) {
          setPhase("confirm_disconnect");
          setConfirmIndex(1); // Default to safe option (Keep)
        } else {
          setPhase("list");
        }
        return;
      }
      return;
    }

    if (phase === "confirm_disconnect") {
      if (key.escape) {
        setPhase("menu");
        return;
      }
      if (key.upArrow || key.downArrow) {
        setConfirmIndex((i) => (i === 0 ? 1 : 0));
        return;
      }
      if (key.return && selected) {
        if (confirmIndex === 0) {
          // Yes, disconnect
          onSaveKey(selected.id, "");
          setPhase("list");
        } else {
          // No, keep key
          setPhase("menu");
        }
        return;
      }
      return;
    }

    // List phase
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      const nextIdx = Math.max(0, index - 1);
      setIndex(nextIdx);
      if (onSelect && providers[nextIdx]) {
        onSelect(providers[nextIdx]!.id);
      }
      return;
    }
    if (key.downArrow) {
      const nextIdx = Math.min(providers.length - 1, index + 1);
      setIndex(nextIdx);
      if (onSelect && providers[nextIdx]) {
        onSelect(providers[nextIdx]!.id);
      }
      return;
    }
    if (key.return && selected) {
      if (selected.configured) {
        setPhase("menu");
        setMenuIndex(0);
      } else {
        setPhase("input");
        if (selected.id === "local") {
          setLocalStep("baseUrl");
          setKeyBuffer(profiles?.local?.baseUrl ?? "http://localhost:11434/v1");
        } else {
          setKeyBuffer("");
        }
      }
    }
  }, [])
  );

  let footerLeft = "";
  let footerRight = "";
  if (phase === "list") {
    if (innerWidth >= 50) {
      footerLeft = "Enter select · ↑↓ navigate";
      footerRight = "Esc close";
    } else {
      footerLeft = "Enter:sel · ↑↓:nav";
      footerRight = "Esc:close";
    }
  } else if (phase === "menu") {
    if (innerWidth >= 50) {
      footerLeft = "Enter choose · ↑↓ navigate";
      footerRight = "Esc back";
    } else {
      footerLeft = "Enter:choose · ↑↓:nav";
      footerRight = "Esc:back";
    }
  } else if (phase === "confirm_disconnect") {
    if (innerWidth >= 50) {
      footerLeft = "Enter confirm · ↑↓ navigate";
      footerRight = "Esc back";
    } else {
      footerLeft = "Enter:confirm · ↑↓:nav";
      footerRight = "Esc:back";
    }
  } else if (phase === "input") {
    if (innerWidth >= 50) {
      footerLeft = "Enter save & connect · Esc cancel";
    } else {
      footerLeft = "Enter:save · Esc:cancel";
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={overlayWidth}
    >
      {/* Header section */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" overflow="hidden">
        <Box flexDirection="row">
          <Box width={3}>
            <Text color={theme.text} bold>🔌</Text>
          </Box>
          <Text color={theme.text} bold wrap="truncate">
            Providers
          </Text>
        </Box>
      </Box>

      <Box marginTop={0} overflow="hidden">
        <Text color={theme.muted} dimColor wrap="wrap">
          {phase === "list" && (innerWidth >= 50 ? "Select a provider to connect or manage" : "Select a provider")}
          {phase === "menu" && `Manage ${selected?.label}`}
          {phase === "confirm_disconnect" && `Remove the stored key for ${selected?.label}`}
          {phase === "input" && `Enter API key for ${selected?.label}`}
        </Text>
      </Box>

      {/* Divider */}
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {/* Main Content Area */}
      <Box marginTop={0} marginBottom={1} flexDirection="column" overflow="hidden">
        {phase === "list" && (() => {
          const labelW = Math.min(18, Math.max(10, Math.floor(innerWidth * 0.25)));
          return providers.map((p, i) => {
            const sel = i === safe;
            
            let statusText = "";
            if (p.configured) {
              if (innerWidth >= 45) {
                statusText = `✓ connected${p.modelCount ? ` · ${p.modelCount} models` : ""}`;
              } else if (innerWidth >= 40) {
                statusText = `✓ connected${p.modelCount ? ` · ${p.modelCount}` : ""}`;
              } else {
                statusText = "✓ connected";
              }
            } else {
              statusText = innerWidth >= 40 ? "· not connected" : "·";
            }

            const arrowStr = sel ? "▸ " : "  ";
            const iconStr = p.icon.padEnd(4);
            const labelStr = p.label.slice(0, labelW).padEnd(labelW);

            return (
              <Box key={p.id} height={1} overflow="hidden">
                <Text wrap="truncate">
                  <Text color={sel ? theme.accent : theme.muted} bold={sel}>
                    {arrowStr}
                  </Text>
                  <Text>{iconStr}</Text>
                  <Text color={sel ? theme.text : theme.muted} bold={sel}>
                    {labelStr}
                  </Text>
                  <Text color={p.configured ? theme.success : theme.muted} bold={p.configured && sel}>
                    {statusText}
                  </Text>
                </Text>
              </Box>
            );
          });
        })()}

        {phase === "menu" && selected && (
          <Box flexDirection="column" paddingY={0} overflow="hidden">
            <Box flexDirection="row" alignItems="center" marginBottom={1} overflow="hidden">
              <Box width={4}>
                <Text>{selected.icon}</Text>
              </Box>
              <Text color={theme.text} bold wrap="truncate">
                {selected.label}
              </Text>
              <Box marginLeft={1} overflow="hidden">
                <Text color={theme.success} bold wrap="truncate">
                  {selected.id === "local" ? "✓ configured" : "✓ connected"}
                </Text>
              </Box>
            </Box>

            <Box flexDirection="column" borderStyle="single" borderColor={theme.dimBorder} paddingX={1} width={innerWidth} overflow="hidden">
              <Box marginBottom={1}>
                <Text color={theme.accent} bold>Actions</Text>
              </Box>
              {[
                { label: selected.id === "local" ? "Update settings" : "Update API key", idx: 0 },
                { label: selected.id === "local" ? "Reset configuration" : "Disconnect", idx: 1 },
                { label: "Cancel", idx: 2 },
              ].map((opt) => {
                const isSel = opt.idx === menuIndex;
                return (
                  <Box key={opt.idx} overflow="hidden">
                    <Text wrap="wrap">
                      <Text color={isSel ? theme.accent : theme.muted} bold={isSel}>
                        {isSel ? "▸ " : "  "}
                      </Text>
                      <Text color={isSel ? theme.text : theme.muted} bold={isSel}>
                        {opt.label}
                      </Text>
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {phase === "confirm_disconnect" && selected && (
          <Box flexDirection="column" paddingY={0} overflow="hidden">
            <Box flexDirection="row" alignItems="center" marginBottom={1} overflow="hidden">
              <Box width={4}>
                <Text color={theme.warning}>■</Text>
              </Box>
              <Text color={theme.warning} bold wrap="wrap">
                Disconnect provider
              </Text>
            </Box>

            <Box flexDirection="column" borderStyle="single" borderColor={theme.danger} paddingX={2} paddingY={1} width={innerWidth} overflow="hidden">
              <Text color={theme.text} bold wrap="truncate">
                Remove the stored key for {selected.label}?
              </Text>
              <Box marginTop={1} flexDirection="column" overflow="hidden">
                {[
                  { label: "Disconnect", val: 0 },
                  { label: "Keep key", val: 1 },
                ].map((opt) => {
                  const isSel = opt.val === confirmIndex;
                  return (
                    <Box key={opt.val} height={1} overflow="hidden">
                      <Text wrap="truncate">
                        <Text color={isSel ? theme.danger : theme.muted} bold={isSel}>
                          {isSel ? "▸ " : "  "}
                        </Text>
                        <Text color={isSel ? theme.text : theme.muted} bold={isSel}>
                          {opt.label}
                        </Text>
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>
        )}

        {phase === "input" && selected && (
          <Box flexDirection="column" paddingY={0} overflow="hidden">
            <Box flexDirection="row" alignItems="center" overflow="hidden">
              <Box width={4}>
                <Text>{selected.icon}</Text>
              </Box>
              <Text color={theme.text} bold wrap="truncate">
                Connect {selected.label}
              </Text>
            </Box>

            {selected.id === "local" ? (
              <Box flexDirection="column" marginTop={1} overflow="hidden">
                <Box marginBottom={0}>
                  <Text color={localStep === "baseUrl" ? theme.accent : theme.muted} bold={localStep === "baseUrl"} wrap="truncate">
                    {localStep === "baseUrl" ? "▸ " : "  "}1. Base URL: {localStep !== "baseUrl" ? (localBaseUrl || "http://localhost:11434/v1") : ""}
                  </Text>
                </Box>
                <Box marginBottom={0}>
                  <Text color={localStep === "model" ? theme.accent : theme.muted} bold={localStep === "model"} wrap="truncate">
                    {localStep === "model" ? "▸ " : "  "}2. Model Name: {localStep !== "model" && localStep !== "baseUrl" ? (localModel || "llama3.2") : ""}
                  </Text>
                </Box>
                <Box marginBottom={1}>
                  <Text color={localStep === "apiKey" ? theme.accent : theme.muted} bold={localStep === "apiKey"} wrap="truncate">
                    {localStep === "apiKey" ? "▸ " : "  "}3. API Key (Optional):
                  </Text>
                </Box>

                <Box
                  borderStyle="single"
                  borderColor={theme.accent}
                  paddingX={1}
                  paddingY={0}
                  flexDirection="row"
                  alignItems="center"
                  width={innerWidth}
                  overflow="hidden"
                >
                  <Box width={3}>
                    <Text color={theme.accent} bold>
                      {localStep === "baseUrl" ? "◆" : localStep === "model" ? "◈" : "■"}
                    </Text>
                  </Box>
                  <Text color={theme.accent} bold>
                    {localStep === "baseUrl" ? "Base URL: " : localStep === "model" ? "Model: " : "API Key: "}
                  </Text>
                  {keyBuffer.length > 0 ? (
                    <Text color={theme.text} bold wrap="wrap">
                      {localStep === "apiKey" ? "•".repeat(Math.min(keyBuffer.length, 45)) : keyBuffer}
                    </Text>
                  ) : (
                    <Text color={theme.muted} italic wrap="wrap">
                      {localStep === "baseUrl"
                        ? "Enter URL (e.g. http://localhost:11434/v1)..."
                        : localStep === "model"
                        ? "Enter model name (e.g. llama3.2)..."
                        : "Enter optional API key or token..."}
                    </Text>
                  )}
                  <Text color={theme.accent} bold>▎</Text>
                </Box>
              </Box>
            ) : (
              <Box
                borderStyle="single"
                borderColor={theme.accent}
                paddingX={1}
                paddingY={0}
                marginTop={1}
                flexDirection="row"
                alignItems="center"
                width={innerWidth}
                overflow="hidden"
              >
                <Box width={3}>
                  <Text color={theme.accent} bold>🔑</Text>
                </Box>
                <Text color={theme.accent} bold>API Key: </Text>
                {keyBuffer.length > 0 ? (
                  <Text color={theme.text} bold wrap="truncate">
                    {"•".repeat(Math.min(keyBuffer.length, 45))}
                    {keyBuffer.length > 45 ? "..." : ""}
                  </Text>
                ) : (
                  <Text color={theme.muted} italic wrap="truncate">Paste or type your API token here...</Text>
                )}
                <Text color={theme.accent} bold>▎</Text>
              </Box>
            )}

            <Box marginTop={1} paddingX={1} overflow="hidden">
              <Text color={theme.muted} dimColor wrap="truncate">
                Saved to <Text color={theme.warning} bold>~/.agency/config.json</Text>
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Divider */}
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {/* Footer Navigation Bar */}
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Text color={theme.muted} dimColor wrap="truncate">{footerLeft}</Text>
        {footerRight ? <Text color={theme.muted} dimColor wrap="truncate">{footerRight}</Text> : null}
      </Box>
    </Box>
  );
}
