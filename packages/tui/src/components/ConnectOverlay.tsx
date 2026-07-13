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
  local: { label: "Local (Ollama)", icon: "💻" },
};

export function getProviderInfo(id: string): { label: string; icon: string } {
  const defaultInfo = PROVIDER_INFO[id];
  if (defaultInfo) return defaultInfo;
  if (id === "add_custom") {
    return { label: "Add Custom Provider", icon: "" };
  }
  const label = id.charAt(0).toUpperCase() + id.slice(1);
  return { label, icon: "🧩" };
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
  const innerWidth = overlayWidth - 6;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("list");
  const [keyBuffer, setKeyBuffer] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [confirmIndex, setConfirmIndex] = useState(0);

  const [wizardSteps, setWizardSteps] = useState<("id" | "baseUrl" | "apiKey" | "model")[]>(["apiKey"]);
  const [stepIdx, setStepIdx] = useState(0);

  const [inputId, setInputId] = useState("");
  const [inputBaseUrl, setInputBaseUrl] = useState("");
  const [inputApiKey, setInputApiKey] = useState("");
  const [inputModel, setInputModel] = useState("");

  const listItems: ProviderStatus[] = [
    ...providers,
    { id: "add_custom" as any, label: "Add Custom Provider", icon: "", configured: false }
  ];

  const safe = listItems.length === 0 ? 0 : index % listItems.length;
  const selected = listItems[safe];

  const stateRef = useRef({
    phase,
    index,
    listItems,
    keyBuffer,
    menuIndex,
    confirmIndex,
    wizardSteps,
    stepIdx,
    inputId,
    inputBaseUrl,
    inputApiKey,
    inputModel,
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
      listItems,
      keyBuffer,
      menuIndex,
      confirmIndex,
      wizardSteps,
      stepIdx,
      inputId,
      inputBaseUrl,
      inputApiKey,
      inputModel,
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
        listItems,
        keyBuffer,
        menuIndex,
        confirmIndex,
        wizardSteps,
        stepIdx,
        inputId,
        inputBaseUrl,
        inputApiKey,
        inputModel,
        selected,
        onSaveKey,
        onClose,
        onSelect,
        profiles,
      } = stateRef.current;

      if (phase === "input") {
        if (key.escape) {
          if (stepIdx > 0) {
            const prevStep = wizardSteps[stepIdx - 1];
            setStepIdx(stepIdx - 1);
            if (prevStep === "id") setKeyBuffer(inputId);
            else if (prevStep === "baseUrl") setKeyBuffer(inputBaseUrl);
            else if (prevStep === "model") setKeyBuffer(inputModel);
            else if (prevStep === "apiKey") setKeyBuffer(inputApiKey);
            return;
          }
          setPhase(selected?.configured ? "menu" : "list");
          setKeyBuffer("");
          return;
        }

        if (key.return) {
          const currentStep = wizardSteps[stepIdx];
          let nextId = inputId;
          let nextBaseUrl = inputBaseUrl;
          let nextModel = inputModel;
          let nextApiKey = inputApiKey;

          if (currentStep === "id") {
            const val = keyBuffer.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
            if (!val || val === "add_custom" || ["nvidia", "openrouter", "google", "openai", "anthropic", "local"].includes(val)) {
              return;
            }
            nextId = val;
            setInputId(val);
          } else if (currentStep === "baseUrl") {
            const defaultUrl = selected?.id === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1";
            const val = keyBuffer.trim() || defaultUrl;
            nextBaseUrl = val;
            setInputBaseUrl(val);
          } else if (currentStep === "model") {
            const defaultModel = selected?.id === "local" ? "llama3.2" : "default";
            const val = keyBuffer.trim() || defaultModel;
            nextModel = val;
            setInputModel(val);
          } else if (currentStep === "apiKey") {
            const val = keyBuffer.trim();
            nextApiKey = val;
            setInputApiKey(val);
          }

          if (stepIdx < wizardSteps.length - 1) {
            const nextStep = wizardSteps[stepIdx + 1];
            setStepIdx(stepIdx + 1);
            if (nextStep === "baseUrl") {
              setKeyBuffer(nextBaseUrl);
            } else if (nextStep === "model") {
              setKeyBuffer(nextModel);
            } else if (nextStep === "apiKey") {
              setKeyBuffer(nextApiKey);
            }
            return;
          } else {
            const targetId = selected.id === "add_custom" ? nextId : selected.id;
            if (targetId === "local" || selected.id === "add_custom" || !["nvidia", "openrouter", "google", "openai", "anthropic"].includes(targetId as string)) {
              onSaveKey(targetId, nextApiKey, {
                baseUrl: nextBaseUrl,
                model: nextModel,
              });
            } else {
              onSaveKey(targetId, nextApiKey);
            }
            setPhase("list");
            setKeyBuffer("");
            return;
          }
        }

        const isCtrlH = key.ctrl && (input === "h" || (key as any).name === "h");
        const isBackspace = key.backspace || (key as any).name === "backspace" || input === "\b" || input === "\x08" || input === "\x7f";
        const isBackspaceOrDelete = isBackspace || key.delete || (key as any).name === "delete" || isCtrlH;

        if (isBackspaceOrDelete) {
          setKeyBuffer((b) => deleteLastGrapheme(b));
          return;
        }

        if (input.includes("\x1b")) {
          return;
        }

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
              setWizardSteps(["baseUrl", "model", "apiKey"]);
              setStepIdx(0);
              setInputBaseUrl(profiles?.local?.baseUrl ?? "http://localhost:11434/v1");
              setInputModel(profiles?.local?.model ?? "llama3.2");
              setInputApiKey(profiles?.local?.apiKey ?? "");
              setKeyBuffer(profiles?.local?.baseUrl ?? "http://localhost:11434/v1");
            } else if (selected.id !== "add_custom" && !["nvidia", "openrouter", "google", "openai", "anthropic"].includes(selected.id as string)) {
              setWizardSteps(["baseUrl", "apiKey", "model"]);
              setStepIdx(0);
              const prof = profiles?.[selected.id] ?? {};
              setInputBaseUrl(prof.baseUrl ?? "");
              setInputApiKey(prof.apiKey ?? "");
              setInputModel(prof.model ?? "");
              setKeyBuffer(prof.baseUrl ?? "");
            } else {
              setWizardSteps(["apiKey"]);
              setStepIdx(0);
              const prof = profiles?.[selected.id] ?? {};
              setInputApiKey(prof.apiKey ?? "");
              setKeyBuffer("");
            }
          } else if (menuIndex === 1) {
            setPhase("confirm_disconnect");
            setConfirmIndex(1);
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
            onSaveKey(selected.id, "");
            setPhase("list");
          } else {
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
        if (onSelect && listItems[nextIdx] && listItems[nextIdx].id !== "add_custom") {
          onSelect(listItems[nextIdx].id);
        }
        return;
      }
      if (key.downArrow) {
        const nextIdx = Math.min(listItems.length - 1, index + 1);
        setIndex(nextIdx);
        if (onSelect && listItems[nextIdx] && listItems[nextIdx].id !== "add_custom") {
          onSelect(listItems[nextIdx].id);
        }
        return;
      }
      if (key.return && selected) {
        if (selected.id === "add_custom") {
          setPhase("input");
          setWizardSteps(["id", "baseUrl", "apiKey", "model"]);
          setStepIdx(0);
          setInputId("");
          setInputBaseUrl("https://api.openai.com/v1");
          setInputApiKey("");
          setInputModel("default");
          setKeyBuffer("");
        } else if (selected.configured) {
          setPhase("menu");
          setMenuIndex(0);
        } else {
          setPhase("input");
          if (selected.id === "local") {
            setWizardSteps(["baseUrl", "model", "apiKey"]);
            setStepIdx(0);
            setInputBaseUrl(profiles?.local?.baseUrl ?? "http://localhost:11434/v1");
            setInputModel(profiles?.local?.model ?? "llama3.2");
            setInputApiKey(profiles?.local?.apiKey ?? "");
            setKeyBuffer(profiles?.local?.baseUrl ?? "http://localhost:11434/v1");
          } else {
            setWizardSteps(["apiKey"]);
            setStepIdx(0);
            setInputApiKey("");
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
          {phase === "input" && `Configure ${selected?.label}`}
        </Text>
      </Box>

      {/* Divider */}
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {/* Main Content Area */}
      <Box marginTop={0} marginBottom={1} flexDirection="column" overflow="hidden">
        {phase === "list" && (() => {
          return listItems.map((p, i) => {
            const sel = i === safe;
            
            let statusText = "";
            if (p.configured) {
              if (innerWidth >= 45) {
                statusText = `connected${p.modelCount ? ` · ${p.modelCount} models` : ""}`;
              } else if (innerWidth >= 40) {
                statusText = `connected${p.modelCount ? ` · ${p.modelCount}` : ""}`;
              } else {
                statusText = "connected";
              }
            } else if (p.id === "add_custom") {
              statusText = "";
            } else {
              statusText = innerWidth >= 40 ? "not connected" : "offline";
            }

            const arrowStr = sel ? ">" : "";
            const truncatedLabel = p.label;

            return (
              <Box key={p.id} height={1} overflow="hidden" flexDirection="row">
                <Box width={3}>
                  <Text color={sel ? theme.accent : theme.muted}>
                    {arrowStr}
                  </Text>
                </Box>
                <Box width={4}>
                  <Text color={p.id === "add_custom" ? theme.accent : undefined} bold={p.id === "add_custom"}>
                    {p.icon}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={sel ? theme.text : theme.muted} bold={sel} wrap="truncate">
                    {truncatedLabel}
                  </Text>
                </Box>
                {statusText ? (
                  <Box marginLeft={2}>
                    <Text color={p.configured ? theme.success : theme.muted} bold={p.configured && sel}>
                      {statusText}
                    </Text>
                  </Box>
                ) : null}
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
                  {selected.id === "local" ? "configured" : "connected"}
                </Text>
              </Box>
            </Box>

            <Box flexDirection="column" borderStyle="single" borderColor={theme.dimBorder} paddingX={1} width={innerWidth} overflow="hidden">
              <Box marginBottom={1}>
                <Text color={theme.accent} bold>Actions</Text>
              </Box>
              {[
                { label: selected.id === "local" || (selected.id !== "add_custom" && !["nvidia", "openrouter", "google", "openai", "anthropic"].includes(selected.id as string)) ? "Update settings" : "Update API key", idx: 0 },
                { label: selected.id === "local" || (selected.id !== "add_custom" && !["nvidia", "openrouter", "google", "openai", "anthropic"].includes(selected.id as string)) ? "Reset configuration" : "Disconnect", idx: 1 },
                { label: "Cancel", idx: 2 },
              ].map((opt) => {
                const isSel = opt.idx === menuIndex;
                return (
                  <Box key={opt.idx} overflow="hidden">
                    <Text wrap="wrap">
                      <Text color={isSel ? theme.accent : theme.muted}>
                        {isSel ? "> " : "  "}
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
                        <Text color={isSel ? theme.danger : theme.muted}>
                          {isSel ? "> " : "  "}
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
                <Text>{selected.id === "add_custom" ? (stepIdx === 0 ? "" : "🧩") : selected.icon}</Text>
              </Box>
              <Text color={theme.text} bold wrap="truncate">
                Configure {selected.id === "add_custom" && inputId ? inputId : selected.label}
              </Text>
            </Box>

            {wizardSteps.length > 1 ? (
              <Box flexDirection="column" marginTop={1} overflow="hidden">
                {wizardSteps.map((step, idx) => {
                  const isCurrent = idx === stepIdx;
                  let stepValue = "";
                  if (step === "id") stepValue = inputId;
                  else if (step === "baseUrl") stepValue = inputBaseUrl;
                  else if (step === "model") stepValue = inputModel;
                  else if (step === "apiKey") stepValue = inputApiKey;

                  let stepLabel = "";
                  if (step === "id") stepLabel = "Provider ID";
                  else if (step === "baseUrl") stepLabel = "Base URL";
                  else if (step === "apiKey") stepLabel = "API Key";
                  else if (step === "model") stepLabel = "Default Model";

                  const indicator = isCurrent ? "> " : "  ";

                  return (
                    <Box key={step} marginBottom={0}>
                      <Text
                        color={isCurrent ? theme.accent : theme.muted}
                        bold={isCurrent}
                        wrap="truncate"
                      >
                        {indicator}
                        {idx + 1}. {stepLabel}:{" "}
                        {!isCurrent && stepValue
                          ? step === "apiKey"
                            ? "•".repeat(Math.min(stepValue.length, 12))
                            : stepValue
                          : ""}
                      </Text>
                    </Box>
                  );
                })}

                <Box
                  borderStyle="single"
                  borderColor={theme.accent}
                  paddingX={1}
                  paddingY={0}
                  flexDirection="row"
                  alignItems="center"
                  width={innerWidth}
                  overflow="hidden"
                  marginTop={1}
                >
                  <Box width={3}>
                    <Text color={theme.accent} bold>
                      {wizardSteps[stepIdx] === "id"
                        ? "🆔"
                        : wizardSteps[stepIdx] === "baseUrl"
                        ? "🔗"
                        : wizardSteps[stepIdx] === "model"
                        ? "🤖"
                        : "🔑"}
                    </Text>
                  </Box>
                  <Text color={theme.accent} bold>
                    {wizardSteps[stepIdx] === "id"
                      ? "ID: "
                      : wizardSteps[stepIdx] === "baseUrl"
                      ? "Base URL: "
                      : wizardSteps[stepIdx] === "model"
                      ? "Model: "
                      : "API Key: "}
                  </Text>
                  {keyBuffer.length > 0 ? (
                    <Text color={theme.text} bold wrap="wrap">
                      {wizardSteps[stepIdx] === "apiKey"
                        ? "•".repeat(Math.min(keyBuffer.length, 45))
                        : keyBuffer}
                    </Text>
                  ) : (
                    <Text color={theme.muted} italic wrap="wrap">
                      {wizardSteps[stepIdx] === "id"
                        ? "Enter custom ID (e.g. tokenrouter)..."
                        : wizardSteps[stepIdx] === "baseUrl"
                        ? "Enter URL (e.g. http://localhost:11434/v1)..."
                        : wizardSteps[stepIdx] === "model"
                        ? "Enter default model (e.g. llama3.2)..."
                        : "Enter optional API key..."}
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
