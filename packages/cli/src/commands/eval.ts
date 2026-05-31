import { Command } from "commander";
import { spawn } from "node:child_process";
import {
  getWorkspaceRoot,
  resolveSkillsRoot,
  runChatTurnWithStream,
  runVerifyLoop,
  getRuntimeFlags,
  toolApprovalEngine,
} from "@agency/core";
import {
  defaultTasks,
  agentEvalTasks,
  hardAgentEvalTasks,
  runBenchmarkSuite,
  aggregateResults,
  formatEvalReport,
  gateAgainstBaseline,
  loadBaseline,
  saveBaseline,
  estimateTokenCost,
  type BenchmarkTask,
  type ExecuteContext,
  type ExecuteOutcome,
} from "@agency/benchmark";

interface EvalOptions {
  agent?: boolean;
  suite: string;
  baseline: string;
  updateBaseline?: boolean;
  tolerance: string;
  budget: string;
  provider?: string;
  json?: boolean;
}

/**
 * Runs a corpus task's CommonJS acceptance test capturing stdout+stderr (the
 * task's own `validate` runs the same test with `stdio:ignore` for the final
 * grade). The captured output is what the verify loop feeds back to the agent on
 * a failing round, so an informative test (one that prints the failing cases) is
 * what makes self-correction work.
 */
function runNodeAcceptance(
  projectRoot: string,
  testFile: string
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [testFile], { cwd: projectRoot, shell: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) =>
      resolve({ passed: code === 0, output: out.trim() || `acceptance test exited ${code}` })
    );
    child.on("error", (err) =>
      resolve({ passed: false, output: `failed to run acceptance test: ${err.message}` })
    );
  });
}

/**
 * Builds the agent attempt for a corpus task and wraps it in the REAL verify
 * loop (`runVerifyLoop` from core), with acceptance == the task's own acceptance
 * test. This is the crux of a meaningful legacy↔hardened comparison:
 *   - legacy   (verifyLoop off) → maxRounds 1 → a single one-shot attempt.
 *   - hardened (verifyLoop on)  → up to verifyMaxRounds attempts, re-running the
 *     turn with the failing cases fed back, so a near-miss self-corrects.
 * Because acceptance is the exact grade, "loop passed" ⇔ "task passes" — no
 * proxy criterion (the dispatchAgent loop accepts on `npm run build`, which a
 * bare .cjs corpus task does not have).
 */
function makeAgentExecute(
  opts: { skillsRoot: string; providerId?: string }
): (ctx: ExecuteContext) => Promise<ExecuteOutcome> {
  const testFile = "test.cjs"; // corpus convention (makeNodeTask default)
  return async (ctx: ExecuteContext): Promise<ExecuteOutcome> => {
    const flags = getRuntimeFlags();
    const maxRounds = flags.verifyLoop ? Math.max(1, flags.verifyMaxRounds) : 1;
    let costUsd = 0;

    const loop = await runVerifyLoop(
      async (actx) => {
        const prompt =
          actx.round === 1
            ? ctx.objective
            : `${ctx.objective}\n\n[Your previous attempt did NOT pass the acceptance test. Fix the code so every case passes. Failing output:]\n${actx.previousFailures ?? ""}`;
        const result = await runChatTurnWithStream(
          { prompt, projectRoot: ctx.projectRoot, skillsRoot: opts.skillsRoot, providerId: opts.providerId, maxLoops: 15 } as any,
          { onRoute: () => {}, onDelta: () => {}, onThought: () => {} }
        );
        const md = (result as any)?.completionMetadata;
        if (md) {
          costUsd += estimateTokenCost(md.promptTokens ?? 0, md.completionTokens ?? 0, opts.providerId ?? "");
        }
      },
      async () => {
        const r = await runNodeAcceptance(ctx.projectRoot, testFile);
        return { passed: r.passed, failures: r.output };
      },
      { maxRounds, hasBudget: () => costUsd < ctx.budgetLimit }
    );

    // `rounds` now reflects real attempts (1 = one-shot, >1 = self-corrected),
    // not the previously-hardcoded 0.
    return { rounds: loop.rounds, costUsd, intervened: false };
  };
}

function selectCorpus(suite: string): BenchmarkTask[] {
  switch (suite) {
    case "hard":
      return hardAgentEvalTasks;
    case "all":
      return [...agentEvalTasks, ...hardAgentEvalTasks];
    case "easy":
    default:
      return agentEvalTasks;
  }
}

export function registerEval(program: Command) {
  program
    .command("eval")
    .description("Run the task-eval suite and gate task success rate against a baseline")
    .option("--agent", "Attach the real agent runtime to the corpus tasks (needs provider keys)")
    .option("--suite <name>", "Agent corpus to run: easy | hard | all", "easy")
    .option("--baseline <path>", "Baseline report file", ".agency/eval-baseline.json")
    .option("--update-baseline", "Write the current report as the new baseline (no gating)")
    .option("--tolerance <frac>", "Allowed success-rate drop, 0..1", "0")
    .option("--budget <amount>", "Max spend budget in USD per task", "5.0")
    .option("--provider <id>", "Provider to use for --agent runs")
    .option("--json", "Output the report (and gate result) as JSON")
    .action(async (options: EvalOptions) => {
      const projectRoot = getWorkspaceRoot(process.cwd());
      const budget = parseFloat(options.budget);
      const tolerance = parseFloat(options.tolerance);

      // Keep stdout pure JSON: deep modules (router/memory) console.log banners
      // mid-run would corrupt a `--json` consumer. Route stray logs to stderr for
      // the duration of the run; the final JSON is printed after we restore it.
      const originalLog = console.log;
      if (options.json) {
        console.log = ((...args: unknown[]) => console.error(...args)) as typeof console.log;
      }

      // Default: deterministic validation-only smoke suite (no LLM) — proves the
      // measurement+gate pipeline. --agent attaches the real runtime to the
      // broken-state corpus so we measure what the agent actually fixes.
      let tasks: BenchmarkTask[] = defaultTasks;
      if (options.agent) {
        const skillsRoot = resolveSkillsRoot();
        const providerId = options.provider;

        // Auto-approver: eval runs headless (no human to approve), so under the
        // hardened profile `approvalInToolPath=enforce` would block every write
        // and fail tasks for a security reason, not a coding one. CI autonomy
        // mode auto-grants tool calls (still refusing high-destructive ops) so
        // legacy↔hardened differ on *self-correction*, not on the approval gate.
        toolApprovalEngine.setMode("CI");

        const corpus = selectCorpus(options.suite);
        tasks = corpus.map((t) => ({ ...t, execute: makeAgentExecute({ skillsRoot, providerId }) }));
      }

      console.error(
        `Running eval suite (${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${options.agent ? `agent-backed: ${options.suite}` : "validation-only"}, profile=${getRuntimeFlags().profile}, verifyLoop=${getRuntimeFlags().verifyLoop})...`
      );

      let report;
      try {
        report = aggregateResults(await runBenchmarkSuite(tasks, projectRoot, budget));
      } finally {
        console.log = originalLog;
      }

      if (options.updateBaseline) {
        await saveBaseline(options.baseline, report);
        if (options.json) console.log(JSON.stringify({ report, baselineUpdated: options.baseline }, null, 2));
        else console.log(`\n${formatEvalReport(report)}\nBaseline updated → ${options.baseline}`);
        process.exit(0);
      }

      const baseline = await loadBaseline(options.baseline);
      const gate = baseline ? gateAgainstBaseline(report, baseline, { successRateTolerance: tolerance }) : null;

      if (options.json) {
        console.log(JSON.stringify({ report, gate }, null, 2));
      } else {
        console.log(`\n${formatEvalReport(report)}`);
        for (const [cat, s] of Object.entries(report.byCategory)) {
          console.log(`  ${cat}: ${s.passed}/${s.total} (${(s.successRate * 100).toFixed(0)}%)`);
        }
        for (const r of report.results.filter((x) => !x.success)) {
          console.log(`  ✗ ${r.taskId}: ${r.error ?? "failed"}`);
        }
        if (gate) {
          console.log(`\nRegression gate vs ${options.baseline}: ${gate.passed ? "PASS" : "FAIL"} — ${gate.reason}`);
        } else {
          console.log(`\nNo baseline at ${options.baseline} — run with --update-baseline to create one.`);
        }
      }

      process.exit(gate && !gate.passed ? 1 : 0);
    });
}
