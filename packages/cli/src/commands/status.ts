import { Command } from "commander";
import {
  getRuntimeFlags,
  discoverRecoverableTasks,
  getMemoryTelemetry,
  getAgentRegistrySnapshot,
  listCheckpoints,
  EventBus,
} from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";

interface StatusReport {
  projectRoot: string;
  profile: string;
  flags: ReturnType<typeof getRuntimeFlags>;
  events: { inMemoryJournal: number; backpressured: boolean };
  memory: {
    episodes: number;
    vectors: number;
    graphEdges: number;
    dbSizeBytes: number;
  } | null;
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    recoverable: ReturnType<typeof discoverRecoverableTasks>;
  };
  agents: ReturnType<typeof getAgentRegistrySnapshot>;
}

function buildReport(projectRoot: string): StatusReport {
  const flags = getRuntimeFlags();
  const bus = EventBus.getInstance();
  const checkpoints = listCheckpoints(projectRoot);
  const byStatus: Record<string, number> = {};
  for (const cp of checkpoints) {
    byStatus[cp.status] = (byStatus[cp.status] ?? 0) + 1;
  }
  const tel = getMemoryTelemetry(projectRoot);
  return {
    projectRoot,
    profile: flags.profile,
    flags,
    events: {
      inMemoryJournal: bus.getJournal().length,
      backpressured: bus.isBackpressured(),
    },
    memory: tel
      ? {
          episodes: tel.episodes_count,
          vectors: tel.vectors_count,
          graphEdges: tel.graph_edges_count,
          dbSizeBytes: tel.database_size_bytes,
        }
      : null,
    tasks: {
      total: checkpoints.length,
      byStatus,
      recoverable: discoverRecoverableTasks(projectRoot),
    },
    agents: getAgentRegistrySnapshot(),
  };
}

type Flags = ReturnType<typeof getRuntimeFlags>;
const onOff = (b: boolean) => (b ? "on" : "off");

/**
 * Declarative one-row-per-display-line model of the runtime flags for the human
 * `agency status`. Each row names the flag keys it covers, so a test can assert
 * that EVERY flag in `getRuntimeFlags()` is surfaced (none silently omitted —
 * the human view previously hand-picked ~14 of 26 and hid behaviour-changing
 * ones like secretScan / atomicRollback / checkpointStrict). Numeric tunables
 * are folded into their parent toggle's row but still declared as covered.
 */
export function buildFlagRows(f: Flags): { label: string; value: string; keys: (keyof Flags)[] }[] {
  return [
    { label: "Event persistence", value: onOff(f.persistEvents), keys: ["persistEvents"] },
    { label: "Auto-recover", value: f.autoRecover ? `on (≤${f.maxCrashLoops} crash-loops)` : "off", keys: ["autoRecover", "maxCrashLoops"] },
    { label: "Approval in toolpath", value: f.approvalInToolPath, keys: ["approvalInToolPath"] },
    { label: "Delegation guards", value: f.delegationGuards ? `on (depth≤${f.maxDepth}, hops≤${f.maxHops})` : "off", keys: ["delegationGuards", "maxDepth", "maxHops"] },
    { label: "Execution budget", value: f.executionBudgetMs > 0 ? `${f.executionBudgetMs}ms/agent` : "off", keys: ["executionBudgetMs"] },
    { label: "Max parallel agents", value: String(f.maxParallelAgents), keys: ["maxParallelAgents"] },
    { label: "MCP request timeout", value: f.mcpRequestTimeoutMs > 0 ? `${f.mcpRequestTimeoutMs}ms` : "off", keys: ["mcpRequestTimeoutMs"] },
    { label: "Memory GC", value: f.memoryGc ? `on (episodes≤${f.memoryMaxEpisodes}, vectors≤${f.memoryMaxVectors})` : "off", keys: ["memoryGc", "memoryMaxEpisodes", "memoryMaxVectors"] },
    { label: "Semantic recall", value: f.memorySemantic ? "on (vector + FTS hybrid)" : "off (keyword FTS only)", keys: ["memorySemantic"] },
    { label: "Capability routing", value: onOff(f.capabilityRouting), keys: ["capabilityRouting"] },
    { label: "Checkpoint strict", value: f.checkpointStrict ? "on (reject corrupt)" : "off (warn + load)", keys: ["checkpointStrict"] },
    { label: "Atomic rollback", value: onOff(f.atomicRollback), keys: ["atomicRollback"] },
    { label: "Secret scan", value: f.secretScan ? "on (redact/quarantine on persist)" : "off", keys: ["secretScan"] },
    { label: "Verify loop", value: f.verifyLoop ? `on (≤${f.verifyMaxRounds} rounds; build${f.verifyLint ? "+lint" : ""}${f.verifyTests ? "+test" : ""}${f.verifyMainTurn ? "; +main-turn" : ""})` : "off", keys: ["verifyLoop", "verifyMaxRounds", "verifyLint", "verifyTests", "verifyMainTurn"] },
    { label: "Model catalog", value: f.modelCatalog ? "on (models.json)" : "off", keys: ["modelCatalog"] },
    { label: "Context compaction", value: f.contextCompaction ? "on (summarize >70% window)" : "off", keys: ["contextCompaction"] },
    { label: "Trace record", value: f.traceRecord ? "on (.agency/traces)" : "off", keys: ["traceRecord"] },
    { label: "Cognition stream", value: f.cognitionStream ? "on (narrate routing + safety to panel)" : "off", keys: ["cognitionStream"] },
    { label: "Prompt cache prefix", value: f.promptCachePrefix ? "on (static-first → provider prefix cache)" : "off", keys: ["promptCachePrefix"] },
    { label: "Soft approaches", value: f.softApproaches ? "on (scale to a few, not exactly 5)" : "off (exactly 5)", keys: ["softApproaches"] },
    { label: "Resume continuation", value: f.resumeContinuation ? "on (resume notice on loop-limit)" : "off (generic truncation notice)", keys: ["resumeContinuation"] },
    { label: "Compact tool docs", value: f.compactToolDocs ? "on (terse args, fewer prompt tokens)" : "off (verbose per-arg)", keys: ["compactToolDocs"] },
  ];
}

function printHuman(r: StatusReport): void {
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const dim = "\x1b[90m";
  console.log(`${bold}AgencyCLI runtime status${reset}  ${dim}(${r.projectRoot})${reset}`);
  console.log("");
  console.log(`  ${bold}Profile${reset}              ${r.profile}`);
  for (const row of buildFlagRows(r.flags)) {
    console.log(`  ${row.label.padEnd(20)} ${row.value}`);
  }
  console.log("");
  console.log(`  ${bold}Events${reset}               ${r.events.inMemoryJournal} in-memory${r.events.backpressured ? " (backpressured!)" : ""}`);
  console.log("");
  if (r.memory) {
    const mb = (r.memory.dbSizeBytes / (1024 * 1024)).toFixed(1);
    console.log(`  ${bold}Memory${reset}               ${r.memory.episodes} episodes · ${r.memory.vectors} vectors · ${r.memory.graphEdges} edges · ${mb} MB`);
  } else {
    console.log(`  ${bold}Memory${reset}               ${dim}(no store)${reset}`);
  }
  console.log("");
  console.log(`  ${bold}Tasks${reset}                ${r.tasks.total} checkpoint(s)`);
  for (const [status, count] of Object.entries(r.tasks.byStatus)) {
    console.log(`    ${dim}${status}${reset}  ${count}`);
  }
  if (r.tasks.recoverable.length > 0) {
    console.log("");
    console.log(`  ${bold}Resumable${reset} ${dim}(run \`agency task resume <id>\`)${reset}`);
    for (const t of r.tasks.recoverable) {
      console.log(`    ${t.id}  ${dim}${t.status} · task #${t.currentTask} · ${t.completed.length} done · ${t.updatedAt}${reset}`);
    }
  } else {
    console.log("");
    console.log(`  ${dim}No interrupted tasks to resume.${reset}`);
  }
  if (r.agents.length > 0) {
    console.log("");
    console.log(`  ${bold}Agents${reset} ${dim}(capability registry · health · load)${reset}`);
    for (const a of r.agents) {
      const total = a.health.successCount + a.health.failureCount;
      const rate = total === 0 ? "—" : `${Math.round((a.health.successCount / total) * 100)}%`;
      const load = `${a.utilization.inFlight}/${a.utilization.maxConcurrent}`;
      console.log(
        `    ${a.id.padEnd(20)} ${dim}ok ${a.health.successCount} · fail ${a.health.failureCount} · rate ${rate} · load ${load}${reset}`
      );
    }
  }
}

export function registerStatus(program: Command) {
  program
    .command("status")
    .description("Inspect runtime state: flags, events, tasks, and resumable work")
    .option("--project-root <path>", "Project root directory")
    .option("--json", "Emit machine-readable JSON")
    .action((options: { projectRoot?: string; json?: boolean }) => {
      const projectRoot = resolveProjectRoot(options.projectRoot);
      const report = buildReport(projectRoot);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printHuman(report);
      }
    });
}
