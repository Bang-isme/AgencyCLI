import { Command } from "commander";
import { getWorkspaceRoot } from "@agency/core";
import { defaultTasks, runBenchmarkTask, runBenchmarkSuite } from "@agency/benchmark";

export function registerBenchmark(program: Command) {
  program
    .command("benchmark")
    .argument("[task-id]", "Specific benchmark task ID to run")
    .description("Run isolated evaluation benchmarks or list available tasks")
    .option("--list", "List all available benchmark tasks")
    .option("--json", "Output results in raw JSON to stdout")
    .option("--budget <amount>", "Maximum spend budget in USD", "5.0")
    .action(async (taskId: string | undefined, options: { list?: boolean; json?: boolean; budget: string }) => {
      const budgetLimit = parseFloat(options.budget);

      if (options.list) {
        if (options.json) {
          console.log(JSON.stringify(defaultTasks.map(t => ({ id: t.id, name: t.name, objective: t.objective })), null, 2));
        } else {
          console.log("\nAvailable Benchmark Tasks:");
          const headers = ["ID", "Name", "Objective"];
          const rows = defaultTasks.map(t => [t.id, t.name, t.objective]);
          printCustomTable(headers, rows);
        }
        process.exit(0);
      }

      const projectRoot = getWorkspaceRoot(process.cwd());

      if (taskId) {
        const task = defaultTasks.find(t => t.id === taskId);
        if (!task) {
          console.error(`Error: Benchmark task with ID '${taskId}' not found.`);
          process.exit(1);
        }

        if (!options.json) {
          console.warn(`Running benchmark task '${task.name}'...`);
        }

        try {
          const result = await runBenchmarkTask(task, projectRoot, budgetLimit);
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log("\nBenchmark Results:");
            const headers = ["Task ID", "Success", "Duration (ms)", "Cost (USD)", "Error"];
            const rows = [[
              result.taskId,
              result.success ? "YES" : "NO",
              result.durationMs.toString(),
              `$${result.costUsd.toFixed(4)}`,
              result.error || "-"
            ]];
            printCustomTable(headers, rows);
            process.exit(result.success ? 0 : 1);
          }
        } catch (e: any) {
          console.error(`Execution failed: ${e.message}`);
          process.exit(1);
        }
      } else {
        if (!options.json) {
          console.warn("Running all benchmark tasks...");
        }

        try {
          const results = await runBenchmarkSuite(defaultTasks, projectRoot, budgetLimit);
          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log("\nBenchmark Suite Results:");
            const headers = ["Task ID", "Success", "Duration (ms)", "Cost (USD)", "Error"];
            const rows = results.map(r => [
              r.taskId,
              r.success ? "YES" : "NO",
              r.durationMs.toString(),
              `$${r.costUsd.toFixed(4)}`,
              r.error || "-"
            ]);
            printCustomTable(headers, rows);

            const allSuccess = results.every(r => r.success);
            process.exit(allSuccess ? 0 : 1);
          }
        } catch (e: any) {
          console.error(`Suite execution failed: ${e.message}`);
          process.exit(1);
        }
      }
    });
}

function printCustomTable(headers: string[], rows: string[][]) {
  const colWidths = headers.map((header, colIndex) => {
    let maxLength = header.length;
    for (const row of rows) {
      const val = row[colIndex] || "";
      if (val.length > maxLength) {
        maxLength = val.length;
      }
    }
    return maxLength;
  });

  const borderLine = "+" + colWidths.map(w => "-".repeat(w + 2)).join("+") + "+";
  const headerLine = "|" + headers.map((h, i) => " " + h.padEnd(colWidths[i]!) + " ").join("|") + "|";

  console.log(borderLine);
  console.log(headerLine);
  console.log(borderLine);
  for (const row of rows) {
    const rowLine = "|" + row.map((val, i) => " " + (val || "").padEnd(colWidths[i]!) + " ").join("|") + "|";
    console.log(rowLine);
  }
  console.log(borderLine);
}
