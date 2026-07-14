import { listThemeIds, type ThemeId } from "../themes/registry.js";
import {
  exportSessionToFile,
  type AgencySession,
} from "../sessions/store.js";
import { getProviderInfo } from "../components/ConnectOverlay.js";

export interface SlashContext {
  projectRoot: string;
  themeId: string;
  session?: AgencySession;
}

export interface SlashResult {
  handled: boolean;
  exit?: boolean;
  themeId?: ThemeId;
  newSession?: boolean;
  clearRouteCache?: boolean;
  systemLines?: string[];
  /** Open help overlay (no chat spam). */
  showHelp?: boolean;
  /** Run workspace index (incremental). */
  runIndex?: boolean;
  /** Compact session context. */
  compactSession?: boolean;
  /** Compact dry-run preview only. */
  compactDryRun?: boolean;
  /** Open interactive provider connect overlay. */
  showConnect?: boolean;
  /** Open models selector overlay. */
  showModels?: boolean;
  /** Open skills picker overlay. */
  showSkills?: boolean;
  /** Open plugins manager overlay. */
  showPlugins?: boolean;
  /** Open review sub-menu. */
  showReview?: boolean;
  /** Open system status dashboard. */
  showStatus?: boolean;
  /** Open MCP management (redirects to status). */
  showMcp?: boolean;
  /** Inject a prompt to submit automatically. */
  injectPrompt?: string;
  /** Open session resume picker. */
  showResume?: boolean;
  /** Open project picker. */
  showProject?: boolean;
  /** Launch a long-running goal task. */
  goalTask?: string;
  /** Add a recurring schedule. */
  scheduleTask?: string;
  /** Open subagent panel. */
  showAgents?: boolean;
  /** Reload local agency config. */
  reloadConfig?: boolean;
  /** Open variant/thinking selector overlay. */
  showVariant?: boolean;
  /** Open route feedback selector overlay. */
  showRouteOverlay?: boolean;
  /** Update thinking mode configuration */
  thinkingMode?: "show" | "hide";
  toggleThinkingMode?: boolean;
}

export function parseSlashCommand(input: string): {
  name: string;
  args: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const space = body.indexOf(" ");
  if (space === -1) return { name: body.toLowerCase(), args: "" };
  return {
    name: body.slice(0, space).toLowerCase(),
    args: body.slice(space + 1).trim(),
  };
}

export async function executeSlash(
  input: string,
  ctx: SlashContext
): Promise<SlashResult> {
  const parsed = parseSlashCommand(input);
  if (!parsed) return { handled: false };

  const { name, args } = parsed;

  switch (name) {
    case "help":
    case "h":
      return { handled: true, showHelp: true };

    case "exit":
    case "quit":
    case "q":
      return { handled: true, exit: true };

    case "new":
    case "clear":
      return {
        handled: true,
        newSession: true,
        clearRouteCache: true,
        systemLines: ["Started a new session (route cache cleared)."],
      };

    case "sessions":
    case "session":
    case "resume":
    case "continue":
      return { handled: true, showResume: true };

    case "themes":
    case "theme": {
      if (!args && name === "themes") {
        return {
          handled: true,
          systemLines: [
            `Themes: ${listThemeIds().join(", ")}`,
            `Active: ${ctx.themeId}`,
            "Use /theme <id> to switch.",
          ],
        };
      }
      const next = (args || "agency").toLowerCase();
      if (!listThemeIds().includes(next as ThemeId)) {
        return {
          handled: true,
          systemLines: [`Unknown theme "${next}". Available: ${listThemeIds().join(", ")}`],
        };
      }
      return {
        handled: true,
        themeId: next as ThemeId,
        systemLines: [`Theme set to ${next}.`],
      };
    }

    case "index":
      return { handled: true, runIndex: true };

    case "export":
    case "x": {
      if (!ctx.session) {
        return { handled: true, systemLines: ["No active session to export."] };
      }
      const path = exportSessionToFile(ctx.session);
      return {
        handled: true,
        systemLines: [`Exported conversation → ${path}`],
      };
    }

    case "compact": {
      const isDry = args === "dry" || args === "dry-run" || args === "--dry-run";
      return {
        handled: true,
        compactSession: !isDry,
        compactDryRun: isDry,
      };
    }

    // --- Interactive overlay commands ---

    case "connect":
      return { handled: true, showConnect: true };

    case "models":
    case "model": {
      const lowerArgs = args.toLowerCase().trim();
      if (lowerArgs === "reset" || lowerArgs === "reset-override") {
        const { loadAgencyConfig, getModelSpec, getBaselineModelSpec, clearModelOverrideField } = await import("@agency/providers");
        const config = loadAgencyConfig();
        const providerId = config.defaultProvider;
        const profile = config.providers[providerId] ?? {};
        const currentModel = profile.model ?? "";
        if (!currentModel) {
          return { handled: true, systemLines: ["[Error] No model configured."] };
        }
        const spec = getModelSpec(currentModel);
        if (spec.specSource !== "override") {
          return {
            handled: true,
            systemLines: [`No override on \`${currentModel}\` — catalog ${getBaselineModelSpec(currentModel).contextWindow.toLocaleString("en-US")} tokens.`],
          };
        }
        clearModelOverrideField(currentModel, "contextWindow");
        const after = getModelSpec(currentModel);
        return {
          handled: true,
          systemLines: [
            `✓ Cleared stale context override for \`${currentModel}\`.`,
            `  • Context window: ${after.contextWindow.toLocaleString("en-US")} tokens (${after.specSource ?? "catalog"})`,
          ],
        };
      }
      if (lowerArgs === "info" || lowerArgs === "spec" || lowerArgs === "specs") {
        const { loadAgencyConfig, getModelSpec } = await import("@agency/providers");
        const config = loadAgencyConfig();
        const providerId = config.defaultProvider;
        const profile = config.providers[providerId] ?? {};
        const currentModel = profile.model ?? "(default)";
        const modelSpec = getModelSpec(currentModel);

        return {
          handled: true,
          systemLines: [
            `Model Specs Diagnostics:`,
            `  • Model ID: \`${currentModel}\``,
            `  • Provider: \`${getProviderInfo(providerId).label}\``,
            `  • Context Window: \`${modelSpec.contextWindow.toLocaleString("en-US")} tokens\``,
            `  • Max Output Limit: \`${modelSpec.maxOutputTokens.toLocaleString("en-US")} tokens\``,
            `  • Thinking Capability: \`${modelSpec.thinkingType}\``,
            modelSpec.freeRateLimit ? `  • Rate Limits: \`${modelSpec.freeRateLimit.rpm} RPM / ${modelSpec.freeRateLimit.tpm.toLocaleString("en-US")} TPM\`` : `  • Rate Limits: \`unlimited / custom\``,
            `  • Spec Source: \`${(modelSpec as any).specSource ?? "dynamic/heuristics"}\``,
            `  ◆ You can override these specifications at any time by configuring "modelOverrides" in ~/.agency/config.json`,
          ],
        };
      }
      if (lowerArgs.startsWith("probe")) {
        let targetModel = "";
        let force = false;

        const parts = args.trim().split(/\s+/).slice(1);
        const cleanParts = parts.filter((p) => {
          if (p === "--force" || p === "-f") {
            force = true;
            return false;
          }
          return true;
        });
        targetModel = cleanParts.join(" ").trim();

        const { loadAgencyConfig, probeModel, updateModelOverride } = await import("@agency/providers");
        const config = loadAgencyConfig();
        const providerId = config.defaultProvider;
        const profile = config.providers[providerId] ?? {};

        if (!targetModel) {
          targetModel = profile.model ?? "";
        }
        if (!targetModel) {
          return {
            handled: true,
            systemLines: [`[Error] Cannot diagnose: No model is selected or configured.`],
          };
        }

        try {
          const res = await probeModel(providerId, targetModel, config);
          let saved = false;

          let changed = false;
          if (res.success) {
            changed =
              res.contextWindow !== res.baselineContextWindow ||
              res.maxOutputTokens !== res.baselineMaxOutput ||
              res.thinkingType !== res.baselineThinking;

            const shouldSave = (changed || force) && (!config.modelOverrides?.[targetModel] || force);
            if (shouldSave) {
              updateModelOverride(targetModel, {
                contextWindow: res.contextWindow,
                maxOutputTokens: res.maxOutputTokens,
                thinkingType: res.thinkingType,
              });
              saved = true;
            }
          }

          const saveMessage = saved
            ? `  ✓ Configuration has been automatically saved to: \`~/.agency/config.json\``
            : (changed
              ? `  ℹ Kept old configuration (use \`--force\` flag to force overwrite).`
              : `  ✓ Result matches baseline. Default preserved (no override written).`);

          const lines = [
            `◈ Model diagnostics result: \`${targetModel}\` (Provider: ${getProviderInfo(providerId).label})`,
            `  • Diagnostic status: ${res.success ? "✓ passed" : "✗ failed"}`,
            `  • Context Window: \`${res.contextWindow.toLocaleString("en-US")} tokens\``,
            `  • Max Output Tokens: \`${res.maxOutputTokens.toLocaleString("en-US")} tokens\``,
            `  • Thinking/Reasoning support: \`${res.thinkingType}\``,
            `  • Tool-calling support: \`${res.supportsTools ? "yes" : "no"}\``,
            saveMessage,
            ``,
            `📝 Detailed diagnostic log (Probe Tracing Logs):`,
            ...res.traceLogs.map((l) => `  ${l}`),
          ];

          return {
            handled: true,
            reloadConfig: saved,
            systemLines: lines,
          };
        } catch (err: any) {
          return {
            handled: true,
            systemLines: [
              `[Error] Diagnostic process encountered an exception: ${err.message}`,
            ],
          };
        }
      }
      return { handled: true, showModels: true };
    }

    case "setup": {
      const { getWorkspaceReadiness, resolveSkillsRoot } = await import("@agency/core");
      const readiness = await getWorkspaceReadiness(ctx.projectRoot);
      const skillsRoot = (() => {
        try { return resolveSkillsRoot(); } catch { return "(not found)"; }
      })();
      const lines = [
        `* Workspace Setup & Readiness Check:`,
        `  • Project root: ${ctx.projectRoot}`,
        `  • Skills Pack:  ${skillsRoot}`,
        `  • Status checks:`,
      ];
      for (const check of readiness) {
        const icon = check.state === "ready" ? "✓" : "x";
        lines.push(`    ${icon} ${check.label}: ${check.detail}`);
      }
      return {
        handled: true,
        systemLines: lines,
      };
    }

    case "doctor": {
      const { resolveSkillsRoot, getWorkspaceReadiness } = await import("@agency/core");
      const { resolvePythonBin } = await import("@agency/skills-bridge");
      const python = await resolvePythonBin();
      const skillsRoot = (() => {
        try { return resolveSkillsRoot(); } catch { return null; }
      })();
      const readiness = await getWorkspaceReadiness(ctx.projectRoot);

      const lines = [
        `+ Workspace & System Doctor Preflight Report:`,
        `  • Python:      ${python ? `✓ ${python}` : "▲ not found (using heuristic fallback)"}`,
        `  • Skills Pack: ${skillsRoot ? `✓ ${skillsRoot}` : "x not found (missing skills manifest)"}`,
        `  • Git Repo:    ${readiness.find(c => c.id === "git")?.state === "ready" ? "✓ ready" : "▲ not a git repository"}`,
        `  • Workspace readiness:`,
      ];
      for (const check of readiness) {
        const icon = check.state === "ready" ? "✓" : "x";
        lines.push(`    ${icon} [${check.id}] ${check.label}: ${check.detail}`);
      }
      return {
        handled: true,
        systemLines: lines,
      };
    }

    case "browser": {
      const parts = args.trim().split(/\s+/);
      const { getBrowserMcpStatus } = await import("@agency/core");
      const status = getBrowserMcpStatus(ctx.projectRoot);

      if (parts[0] === "open" && parts[1]) {
        const url = parts[1];
        const { platform } = await import("node:os");
        const { exec } = await import("node:child_process");
        let openCommand = "";
        const currentPlatform = platform();
        if (currentPlatform === "win32") {
          openCommand = `cmd.exe /c start "" "${url}"`;
        } else if (currentPlatform === "darwin") {
          openCommand = `open "${url}"`;
        } else {
          openCommand = `xdg-open "${url}"`;
        }
        try {
          exec(openCommand);
          return {
            handled: true,
            systemLines: [
              `✓ Opened URL: ${url}`,
              `  Browser MCP status: ${status.configured ? "configured" : "not configured"}`,
            ],
          };
        } catch (err: any) {
          return {
            handled: true,
            systemLines: [`Error opening URL: ${err.message}`],
          };
        }
      }

      return {
        handled: true,
        systemLines: [
          `B Browser MCP Status Check:`,
          `  • Configured: ${status.configured ? "✓ Yes" : "x No"}`,
          `  • Hint: ${status.hint}`,
          `  • Use '/browser open <url>' to open a web page directly.`,
        ],
      };
    }

    case "team": {
      const { loadTeam, initTeam, addMember } = await import("@agency/core");
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (sub === "init") {
        const nameArgIdx = parts.indexOf("--name");
        const nameVal = nameArgIdx !== -1 ? parts[nameArgIdx + 1] : undefined;
        if (!nameVal) {
          return {
            handled: true,
            systemLines: ["[Error] Team name is required. Usage: /team init --name <team_name>"],
          };
        }
        try {
          initTeam(ctx.projectRoot, nameVal);
          return {
            handled: true,
            systemLines: [
              `✓ Successfully initialized team "${nameVal}"!`,
              `  File written: .agency/team.json`,
            ],
          };
        } catch (err: any) {
          return { handled: true, systemLines: [`[Error] ${err.message}`] };
        }
      }

      if (sub === "member") {
        if (parts[1]?.toLowerCase() === "add") {
          const idIdx = parts.indexOf("--id");
          const nameIdx = parts.indexOf("--name");
          const roleIdx = parts.indexOf("--role");
          const emailIdx = parts.indexOf("--email");

          let id = idIdx !== -1 ? parts[idIdx + 1] : undefined;
          let nameVal = nameIdx !== -1 ? parts[nameIdx + 1] : undefined;
          let role = roleIdx !== -1 ? parts[roleIdx + 1] : undefined;
          const email = emailIdx !== -1 ? parts[emailIdx + 1] : undefined;

          if (!id || !nameVal || !role) {
            // Find positional arguments to fill in the blanks
            const posArgs: string[] = [];
            for (let i = 2; i < parts.length; i++) {
              const part = parts[i]!;
              if (part.startsWith("-")) {
                i++; // skip value of flag
                continue;
              }
              posArgs.push(part);
            }
            if (!id && posArgs.length >= 1) {
              id = posArgs[0]?.toLowerCase();
            }
            if (!nameVal && posArgs.length >= 1) {
              nameVal = id && id !== posArgs[0]?.toLowerCase() ? posArgs[0] : (posArgs[1] ?? posArgs[0]);
            }
            if (!role) {
              role = (posArgs.length >= 3 ? posArgs[2] : undefined) ?? "dev";
            }
          }

          if (!id || !nameVal || !role) {
            return {
              handled: true,
              systemLines: [
                "[Error] Missing arguments. Usage: /team member add --id <id> --name <name> --role <role> [--email <email>]",
                "  (Fallback syntax: /team member add <id> <name> <role>)",
              ],
            };
          }
          try {
            addMember(ctx.projectRoot, { id, name: nameVal, role: role as any, email });
            return {
              handled: true,
              systemLines: [
                `✓ Added member ${nameVal} (${role}) to the team.`,
              ],
            };
          } catch (err: any) {
            return { handled: true, systemLines: [`[Error] ${err.message}`] };
          }
        }
      }

      // Default: show
      try {
        const config = loadTeam(ctx.projectRoot);
        if (!config) {
          return {
            handled: true,
            systemLines: [
              `▲ Team not initialized for this project.`,
              `  Use '/team init --name <name>' to bootstrap team collaboration config.`,
            ],
          };
        }
        const lines = [
          `T Team: ${config.teamName}`,
          `  Members:`,
        ];
        if (config.members && config.members.length > 0) {
          for (const m of config.members) {
            lines.push(`    - [${m.id}] ${m.name} (${m.role})${m.email ? ` <${m.email}>` : ""}`);
          }
        } else {
          lines.push(`    (No members added yet. Run '/team member add ...')`);
        }
        return {
          handled: true,
          systemLines: lines,
        };
      } catch {
        return {
          handled: true,
          systemLines: [
            `▲ Team not found or not initialized.`,
            `  Use '/team init --name <name>' to start.`,
          ],
        };
      }
    }

    case "workflow": {
      const { listWorkflowNames, WORKFLOWS } = await import("@agency/core");
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (sub === "run") {
        const wfName = parts[1];
        if (!wfName) {
          return {
            handled: true,
            systemLines: [`[Error] Workflow name is required. Available: ${listWorkflowNames().join(", ")}`],
          };
        }
        return {
          handled: true,
          systemLines: [
            `⚠ To run workflow "${wfName}" autonomously, please trigger the Goal runner:`,
            `  Use: /goal execute workflow ${wfName} ${parts.slice(2).join(" ")}`,
          ],
        };
      }

      const lines = [
        `W CodexAI Execution Workflows:`,
      ];
      for (const name of listWorkflowNames()) {
        const steps = WORKFLOWS[name].map((s) => s.name).join(" ➔ ");
        lines.push(`  • ${name.padEnd(10)}: ${steps}`);
      }
      lines.push(`  • Use '/workflow run <name>' to see execution instructions.`);
      return {
        handled: true,
        systemLines: lines,
      };
    }

    case "git": {
      return {
        handled: true,
        systemLines: [
          `g Git Operations Bridge:`,
          `  For interactive code review, branch analysis, or diff checks, use the review overlay:`,
          `  Command: /review`,
          `  Or use specialized sub-options:`,
          `    • /review staged        - Review staged changes`,
          `    • /review commit        - Review the last commit`,
          `    • /review branch        - Review current branch changes`,
        ],
      };
    }

    case "handover": {
      const { generateHandover } = await import("@agency/core");
      const { path } = generateHandover(ctx.projectRoot);
      return {
        handled: true,
        systemLines: [
          `H Generated Handover Handoff Report:`,
          `  File written: ${path}`,
          `  This report contains session summary, active tasks, and context details so team members or subsequent sessions can resume with zero context loss.`,
        ],
      };
    }

    case "skills":
    case "skill":
      return { handled: true, showSkills: true };

    case "plugins":
    case "plugin":
      return { handled: true, showPlugins: true };

    case "review": {
      // If args provided, inject prompt directly
      if (args) {
        const subMap: Record<string, string> = {
          commit: "$git review the last commit — summarize changes, check quality, flag issues",
          branch: "$git review the current branch vs main — summarize all changes, identify risks",
          pr: "$git review this as a pull request — check for breaking changes, test coverage",
          staged: "Review staged changes.",
          unstaged: "Review unstaged changes.",
          working_tree: "Review working tree changes.",
          ci: "$git check CI/CD pipeline status and recent build results",
          cd: "$git check CI/CD pipeline status and recent build results",
        };
        const prompt = subMap[args.toLowerCase()];
        if (prompt) {
          const subModeMap: Record<string, "staged" | "unstaged" | "working_tree" | "commit" | "branch" | "pr"> = {
            commit: "commit",
            branch: "branch",
            pr: "pr",
            staged: "staged",
            unstaged: "unstaged",
            working_tree: "working_tree",
          };
          const mode = subModeMap[args.toLowerCase()];
          if (mode) {
            const { GitReviewService } = await import("@agency/core");
            const reviewCtx = await GitReviewService.buildReviewContext({
              projectRoot: ctx.projectRoot,
              mode,
            });
            const formattedPrompt = GitReviewService.formatReviewPrompt(reviewCtx, prompt);
            return { handled: true, injectPrompt: formattedPrompt };
          }
          return { handled: true, injectPrompt: prompt };
        }
      }
      return { handled: true, showReview: true };
    }

    case "viewstatus":
    case "status":
      return { handled: true, showStatus: true };

    case "mcp":
      return { handled: true, showMcp: true };

    case "graph":
      return { handled: true, systemLines: ["Graph view available via /viewstatus"] };

    case "tasks":
    case "task":
      return { handled: true, systemLines: ["Task runner available via /viewstatus"] };

    case "goal": {
      if (!args.trim()) {
        return { handled: true, systemLines: ["Usage: /goal <describe the task>"] };
      }
      return { handled: true, goalTask: args.trim() };
    }

    case "project":
      return { handled: true, showProject: true };

    case "dashboard":
    case "memory": {
      const { existsSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");
      const { exec } = await import("node:child_process");
      const { platform } = await import("node:os");

      const agencyDir = join(ctx.projectRoot, ".agency");
      const codexDir = join(ctx.projectRoot, ".codex");
      const baseDir = existsSync(agencyDir) ? agencyDir : (existsSync(codexDir) ? codexDir : agencyDir);
      const htmlPath = resolve(baseDir, "knowledge", "index.html");

      if (!existsSync(htmlPath)) {
        return {
          handled: true,
          systemLines: [
            `[Error] Memory Dashboard HTML file not found at:`,
            `  ${htmlPath}`,
            `Please run /index or setup your workspace to generate it.`
          ]
        };
      }

      // Convert path to file:// URL for universal clicking/opening compatibility
      const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;

      let openCommand = "";
      const currentPlatform = platform();
      if (currentPlatform === "win32") {
        openCommand = `cmd.exe /c start "" "${htmlPath}"`;
      } else if (currentPlatform === "darwin") {
        openCommand = `open "${htmlPath}"`;
      } else {
        openCommand = `xdg-open "${htmlPath}"`;
      }

      try {
        await new Promise<void>((res, rej) => {
          exec(openCommand, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        return {
          handled: true,
          systemLines: [
            `✓ Opened Memory Dashboard in default browser:`,
            `  URL:  ${fileUrl}`,
            `  Path: ${htmlPath}`
          ]
        };
      } catch (err: any) {
        return {
          handled: true,
          systemLines: [
            `[Warning] Failed to auto-open dashboard: ${err.message}`,
            `You can manually open it:`,
            `  URL:  ${fileUrl}`,
            `  Path: ${htmlPath}`
          ]
        };
      }
    }

    case "route": {
      if (!args.trim()) {
        return {
          handled: true,
          showRouteOverlay: true,
        };
      }
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "feedback") {
        if (!parts[1]) {
          return {
            handled: true,
            showRouteOverlay: true,
          };
        }
        const intent = parts[1].toLowerCase();
        if (!ctx.session) {
          return { handled: true, systemLines: ["No active session to record feedback."] };
        }
        const userMsgs = ctx.session.messages
          .filter((m) => m.role === "user")
          .filter((m) => !m.content.trimStart().startsWith("/") && !m.content.trimStart().startsWith("!"));
        if (userMsgs.length === 0) {
          return {
            handled: true,
            systemLines: ["No natural-language user prompts found in session history (slash/shell commands excluded)."],
          };
        }
        const lastPrompt = userMsgs[userMsgs.length - 1]!.content;
        try {
          const { recordFeedback } = await import("@agency/core");
          recordFeedback(ctx.projectRoot, lastPrompt, intent);
          return {
            handled: true,
            systemLines: [
              `✓ Recorded feedback: linked last prompt keywords to intent "${intent}"`,
              `  Prompt: "${lastPrompt.slice(0, 60)}${lastPrompt.length > 60 ? "..." : ""}"`,
            ],
          };
        } catch (err) {
          return {
            handled: true,
            systemLines: [
              `Error recording feedback: ${err instanceof Error ? err.message : String(err)}`,
            ],
          };
        }
      }
      if (parts[0] === "weights") {
        try {
          const { loadWeights, weightsPath } = await import("@agency/core");
          const weights = loadWeights(ctx.projectRoot);
          if (!weights || !weights.feedback || weights.feedback.length === 0) {
            return {
              handled: true,
              systemLines: [
                `No routing weights recorded yet at: ${weightsPath(ctx.projectRoot)}`,
                `Use '/route feedback <intent>' to record feedback first.`,
              ],
            };
          }
          const lines = [
            `✓ Active Routing Weights:`,
            `  Path: ${weightsPath(ctx.projectRoot)}`,
            `  Total Feedbacks: ${weights.feedback.length}`,
            `  Signals:`,
          ];
          for (const [key, weight] of Object.entries(weights.signals)) {
            lines.push(`    - ${key}: ${weight}`);
          }
          return {
            handled: true,
            systemLines: lines,
          };
        } catch (err) {
          return {
            handled: true,
            systemLines: [
              `Error loading weights: ${err instanceof Error ? err.message : String(err)}`,
            ],
          };
        }
      }
      return {
        handled: true,
        systemLines: ["Unknown option. Use: /route feedback <intent> or /route weights"],
      };
    }

    case "schedule": {
      if (!args.trim()) {
        return {
          handled: true,
          systemLines: [
            "Usage: /schedule <every 5m|30m|1h|daily> <task>",
            "  e.g. /schedule every 30m check test suite",
            "  e.g. /schedule every 1h git pull and build",
          ],
        };
      }
      return { handled: true, scheduleTask: args.trim() };
    }

    case "agents":
      return { handled: true, showAgents: true };

    case "variant": {
      const { loadAgencyConfig, getModelThinkingConfig, getModelSpec } = await import("@agency/providers");
      const config = loadAgencyConfig();
      const providerId = config.defaultProvider;
      const profile = config.providers[providerId] ?? {};
      const currentModel = profile.model ?? "(default)";
      const spec = getModelThinkingConfig(providerId, currentModel);
      const modelSpec = getModelSpec(currentModel);

      if (!spec.supported) {
        return {
          handled: true,
          systemLines: [
            `Model "${currentModel}" (provider: ${providerId}) does not support thinking configurations.`,
            `Max Output: ~${modelSpec.maxOutputTokens.toLocaleString("en-US")} tokens | Context: ~${modelSpec.contextWindow.toLocaleString("en-US")} tokens`,
          ],
        };
      }

      // No args → open interactive overlay
      if (!args) {
        return { handled: true, showVariant: true };
      }

      const lower = args.toLowerCase().trim();
      const matchedVariant = spec.variants.find((v) => v.name === lower);
      let targetValue: string | number;

      if (matchedVariant) {
        targetValue = matchedVariant.value;
      } else {
        const num = parseInt(lower, 10);
        if (!isNaN(num) && num >= 0) {
          targetValue = num;
        } else if (["low", "medium", "high"].includes(lower)) {
          targetValue = lower;
        } else {
          return {
            handled: true,
            systemLines: [
              `Invalid variant value "${args}" for model ${currentModel}.`,
              `Supported levels: ${spec.variants.map((v) => v.name).join(", ")} or a custom number.`,
            ],
          };
        }
      }

      // Warn if custom number exceeds model capacity
      const warnLines: string[] = [];
      if (typeof targetValue === "number" && targetValue > modelSpec.maxOutputTokens * 0.75) {
        warnLines.push(
          `⚠ Budget ${targetValue} exceeds 75% of max output (${modelSpec.maxOutputTokens}). Quality may decrease.`
        );
      }

      // Write config.json
      const { writeFileSync, mkdirSync, existsSync: fsExists } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join: pjoin } = await import("node:path");

      const dir = pjoin(homedir(), ".agency");
      if (!fsExists(dir)) mkdirSync(dir, { recursive: true });
      const cfgPath = pjoin(dir, "config.json");
      let cfg: any = {};
      try {
        const { readFileSync } = await import("node:fs");
        cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch { }

      if (!cfg.providers) cfg.providers = {};
      if (!cfg.providers[providerId]) cfg.providers[providerId] = {};
      cfg.providers[providerId].thinking = targetValue;

      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

      return {
        handled: true,
        reloadConfig: true,
        systemLines: [
          `✓ Thinking level for ${providerId}/${currentModel} set to: ${targetValue}`,
          ...warnLines,
        ],
      };
    }

    case "thinking": {
      const lower = args.toLowerCase().trim();
      if (lower === "show" || lower === "hide") {
        return {
          handled: true,
          thinkingMode: lower as "show" | "hide",
          systemLines: [`Thinking mode set to ${lower}.`],
        };
      }
      return {
        handled: true,
        systemLines: ["Usage: /thinking <show|hide>"],
      };
    }

    case "toggle-thinking": {
      return {
        handled: true,
        toggleThinkingMode: true,
      };
    }

    default:
      return {
        handled: true,
        systemLines: [`Unknown command /${name}. Type /help.`],
      };
  }
}

