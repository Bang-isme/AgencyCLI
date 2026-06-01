import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { execa } from "execa";
import {
  resolveSkillsRoot,
  loadAgencyConfig,
  resolveApiKey,
  type ProviderProfile,
} from "@agency/core";
import { runTool, resolvePythonBin, loadManifestSkills, skillMdPath } from "@agency/skills-bridge";
import { out, handleError } from "../utils.js";
import { pluginApprovalGate } from "../plugin-approval-gate.js";

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  recovery?: string;
}

const GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "▲", fail: "✗" };

export function registerDoctor(program: Command) {
  program
    .command("doctor")
    .description("Check the Agency CLI environment + CodexAI skills pack health")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .option("--deep", "Also run the Python skills-pack health check")
    .action(
      async (options: { json?: boolean; quiet?: boolean; deep?: boolean }) => {
        out.configure({
          surface: options.json ? "json" : "human",
          quiet: options.quiet,
        });

        try {
          const checks: Check[] = [];

          // 1. Python interpreter (enables the full Python router; the CLI
          //    falls back to built-in heuristic routing when it is missing).
          const python = await resolvePythonBin();
          if (python) {
            let version = python;
            try {
              const probe = await execa(python, ["--version"], { reject: false });
              version = (probe.stdout || probe.stderr || python).trim();
            } catch {
              /* keep bare bin name */
            }
            checks.push({
              name: "python",
              status: "ok",
              detail: `${version} (${python})`,
            });
          } else {
            checks.push({
              name: "python",
              status: "warn",
              detail: "not found (tried python3, python, py)",
              recovery:
                "Install Python 3 for full skills-pack routing; without it the CLI uses built-in heuristic routing.",
            });
          }

          // 2. Skills pack — manifest present AND every declared skill resolves
          //    to a real SKILL.md. Checking only that the manifest *file* exists
          //    let a partial/corrupt install report healthy, then fail at runtime
          //    when a declared-but-missing skill is invoked. This is the runtime
          //    (installed-pack) counterpart of the CI bundled-pack integrity test.
          const skillsRoot = resolveSkillsRoot();
          const manifestPath = join(skillsRoot, ".system", "manifest.json");
          if (!existsSync(manifestPath)) {
            checks.push({
              name: "skills-pack",
              status: "warn",
              detail: `manifest not found at ${manifestPath}`,
              recovery:
                "Reinstall the skills pack or point AGENCY_SKILLS_ROOT at a valid pack.",
            });
          } else {
            let declared: string[] | null = null;
            try {
              declared = loadManifestSkills(skillsRoot);
            } catch {
              declared = null;
            }
            if (declared === null) {
              checks.push({
                name: "skills-pack",
                status: "fail",
                detail: `manifest at ${manifestPath} is unreadable / not valid JSON`,
                recovery: "Reinstall the skills pack — its manifest is corrupt.",
              });
            } else {
              const missing = declared.filter(
                (s) => !existsSync(skillMdPath(skillsRoot, s))
              );
              if (missing.length === 0) {
                checks.push({
                  name: "skills-pack",
                  status: "ok",
                  detail: `${skillsRoot} (${declared.length} skills)`,
                });
              } else {
                checks.push({
                  name: "skills-pack",
                  status: "fail",
                  detail: `${missing.length}/${declared.length} declared skill(s) missing SKILL.md: ${missing
                    .slice(0, 3)
                    .join(", ")}${missing.length > 3 ? "…" : ""}`,
                  recovery:
                    "Reinstall the skills pack — it is incomplete (a declared skill has no SKILL.md).",
                });
              }
            }
          }

          // 3. Provider config + resolvable keys
          const cfg = loadAgencyConfig();
          const providers = cfg.providers ?? {};
          const ready = Object.entries(providers).filter(([id, profile]) => {
            const p = profile as ProviderProfile;
            const key = resolveApiKey(p);
            return Boolean(key?.trim()) || Boolean(p?.baseUrl) || id === "local";
          });
          const configPath = join(homedir(), ".agency", "config.json");
          if (ready.length > 0) {
            checks.push({
              name: "providers",
              status: "ok",
              detail: `${ready.length} ready: ${ready
                .map(([id]) => id)
                .join(", ")} (default: ${cfg.defaultProvider})`,
            });
          } else {
            checks.push({
              name: "providers",
              status: "fail",
              detail: existsSync(configPath)
                ? "no provider has a resolvable API key"
                : "no config file found",
              recovery:
                "Run `agency config init`, set a key with `agency config set`, or use `/connect` in the TUI.",
            });
          }

          // 4. Optional deep check — Python skills-pack health
          let packHealth: unknown;
          if (options.deep) {
            if (python) {
              const res = await runTool(
                skillsRoot,
                "pack_health",
                ["--skills-root", skillsRoot, "--format", "json"],
                { yes: true, onBeforeRun: pluginApprovalGate }
              );
              try {
                packHealth = JSON.parse(res.stdout);
              } catch {
                packHealth = res.stdout;
              }
              checks.push({
                name: "pack-health",
                status: res.exitCode === 0 ? "ok" : "warn",
                detail:
                  res.exitCode === 0
                    ? "passed"
                    : "issues reported (run with --json for detail)",
              });
            } else {
              checks.push({
                name: "pack-health",
                status: "warn",
                detail: "skipped (Python unavailable)",
              });
            }
          }

          const failed = checks.some((c) => c.status === "fail");

          if (options.json) {
            out.json({
              ok: !failed,
              checks,
              ...(packHealth !== undefined ? { packHealth } : {}),
            });
          } else {
            out.phase("agency doctor");
            for (const c of checks) {
              out.passthrough(
                `  ${GLYPH[c.status]}  ${c.name.padEnd(12)} ${c.detail}`
              );
            }
            const actions = checks.filter((c) => c.recovery);
            if (actions.length > 0) {
              out.passthrough("");
              for (const c of actions) {
                out.passthrough(`  → ${c.name}: ${c.recovery}`);
              }
            }
          }

          process.exit(failed ? 1 : 0);
        } catch (err) {
          handleError(err, "doctor failed");
        }
      }
    );
}
