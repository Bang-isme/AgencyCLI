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

function printHuman(r: StatusReport): void {
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const dim = "\x1b[90m";
  console.log(`${bold}AgencyCLI runtime status${reset}  ${dim}(${r.projectRoot})${reset}`);
  console.log("");
  console.log(`  ${bold}Profile${reset}              ${r.profile}`);
  console.log(`  Event persistence    ${r.flags.persistEvents ? "on" : "off"}`);
  console.log(`  Auto-recover         ${r.flags.autoRecover ? "on" : "off"}`);
  console.log(`  Approval in toolpath ${r.flags.approvalInToolPath}`);
  console.log(`  Delegation guards    ${r.flags.delegationGuards ? `on (depth≤${r.flags.maxDepth}, hops≤${r.flags.maxHops})` : "off"}`);
  console.log(`  Execution budget     ${r.flags.executionBudgetMs > 0 ? `${r.flags.executionBudgetMs}ms/agent` : "off"}`);
  console.log(`  Max parallel agents  ${r.flags.maxParallelAgents}`);
  console.log(`  Memory GC            ${r.flags.memoryGc ? `on (episodes≤${r.flags.memoryMaxEpisodes}, vectors≤${r.flags.memoryMaxVectors})` : "off"}`);
  console.log(`  Capability routing   ${r.flags.capabilityRouting ? "on" : "off"}`);
  console.log(`  Verify loop          ${r.flags.verifyLoop ? `on (≤${r.flags.verifyMaxRounds} rounds; build${r.flags.verifyLint ? "+lint" : ""}${r.flags.verifyTests ? "+test" : ""})` : "off"}`);
  console.log(`  Model catalog        ${r.flags.modelCatalog ? "on (models.json)" : "off"}`);
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
