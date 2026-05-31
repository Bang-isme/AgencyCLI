import { Command } from "commander";
import {
  ApprovalRequiredError,
  compactContext,
  getWorkspaceRoot,
  resolveSkillsRoot,
} from "@agency/core";
import { writeProcessOutput, exitFromResult } from "../utils.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function registerCompact(program: Command) {
  program
    .command("compact")
    .description(
      "Compact old memory files under .agency or .codex (compact_context.py)"
    )
    .option("--dry-run", "Preview compaction without writing or deleting files")
    .option("--project-root <path>", "Project root directory")
    .option("--max-age-days <n>", "Archive session files older than N days", "90")
    .option("--keep-latest <n>", "Always keep the latest N session files", "5")
    .option("--yes", "Approve mutating compaction (required without --dry-run)")
    .action(
      async (options: {
        dryRun?: boolean;
        projectRoot?: string;
        maxAgeDays?: string;
        keepLatest?: string;
        yes?: boolean;
      }) => {
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const skillsRoot = resolveSkillsRoot();
        const maxAgeDays = Number.parseInt(options.maxAgeDays ?? "90", 10);
        const keepLatest = Number.parseInt(options.keepLatest ?? "5", 10);

        try {
          const { exitCode, stdout, bytesSaved } = await compactContext(
            skillsRoot,
            projectRoot,
            {
              dryRun: options.dryRun,
              maxAgeDays: Number.isFinite(maxAgeDays) ? maxAgeDays : 90,
              keepLatest: Number.isFinite(keepLatest) ? keepLatest : 5,
              yes: options.yes,
            }
          );
          writeProcessOutput(stdout);
          if (bytesSaved !== undefined && bytesSaved > 0) {
            console.error(`Bytes saved (estimate): ${formatBytes(bytesSaved)}`);
          }
          exitFromResult(exitCode);
        } catch (err) {
          if (err instanceof ApprovalRequiredError) {
            console.error(err.message);
            process.exit(1);
          }
          throw err;
        }
      }
    );
}
