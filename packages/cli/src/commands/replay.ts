import { Command } from "commander";
import { replaySessionJournal } from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";
import { out, exitOk, exitFail, handleError } from "../utils.js";

export function registerReplay(program: Command) {
  program
    .command("replay")
    .description(
      "Replay the recorded event journal and verify it has not diverged/corrupted (roadmap §2.5 behaviour-replay foundation)",
    )
    .option("--project-root <path>", "Project root directory")
    .option("--json", "Emit the result as JSON to stdout")
    .action((options: { projectRoot?: string; json?: boolean }) => {
      try {
        const projectRoot = resolveProjectRoot(options.projectRoot);
        const result = replaySessionJournal(projectRoot);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.noJournal) {
          out.result([
            { key: "Journal", value: "no events recorded yet (nothing to replay)" },
          ]);
        } else if (result.ok) {
          out.result([
            { key: "Journal", value: "OK — no divergence" },
            { key: "Events", value: String(result.total) },
            { key: "Verified", value: String(result.verified) },
            { key: "Skipped (spilled)", value: String(result.skipped) },
          ]);
        } else {
          out.failure({
            title: "Event journal replay diverged",
            consequence: `seq ${result.divergence?.sequenceId} (${result.divergence?.action}): ${result.divergence?.reason}`,
            recovery:
              "the journal may be corrupt or tampered — inspect .agency/events/journal.db",
          });
        }

        if (result.ok) exitOk();
        exitFail();
      } catch (err) {
        handleError(err, "replay failed");
      }
    });
}
