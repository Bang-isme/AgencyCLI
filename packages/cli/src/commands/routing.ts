import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  getWorkspaceRoot,
  loadWeights,
  recordFeedback,
  saveWeights,
  tokenize,
  weightsPath,
} from "@agency/core";

interface ParsedFeedback {
  date: string;
  category: string;
  severity: string;
  file: string;
  userFix: string;
  aiVersion: string;
}

function aggregateFeedbackLogs(projectRoot: string): void {
  const agencyFeedbackDir = join(projectRoot, ".agency", "feedback");
  const codexFeedbackDir = join(projectRoot, ".codex", "feedback");
  
  let feedbackDir = "";
  if (existsSync(agencyFeedbackDir)) {
    feedbackDir = agencyFeedbackDir;
  } else if (existsSync(codexFeedbackDir)) {
    feedbackDir = codexFeedbackDir;
  }
  
  if (!feedbackDir) {
    return;
  }

  const folderName = feedbackDir.includes(".agency") ? ".agency/feedback" : ".codex/feedback";
  console.log(`Processing feedback logs in ${folderName}...`);

  let files: string[] = [];
  try {
    files = readdirSync(feedbackDir).filter(f => f.endsWith(".md"));
  } catch (err) {
    console.error(`Failed to read feedback directory: ${(err as Error).message}`);
    return;
  }

  if (files.length === 0) {
    console.log(`No feedback markdown logs found in ${folderName}.`);
    return;
  }

  const parsedEntries: ParsedFeedback[] = [];
  const categories = ["naming", "logic", "style", "performance", "security", "architecture", "other"];
  const severities = ["minor", "moderate", "significant"];

  const categoryCounts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  const fileCounts: Record<string, number> = {};
  for (const c of categories) categoryCounts[c] = 0;
  for (const s of severities) severityCounts[s] = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(feedbackDir, file), "utf8");
      
      const dateMatch = /^Date:\s*(.+)$/m.exec(content);
      const categoryMatch = /^Category:\s*(.+)$/m.exec(content);
      const severityMatch = /^Severity:\s*(.+)$/m.exec(content);
      
      const date = dateMatch ? dateMatch[1]!.trim() : file.substring(0, 10);
      let category = categoryMatch ? categoryMatch[1]!.trim().toLowerCase() : "other";
      if (!categories.includes(category)) category = "other";
      
      let severity = severityMatch ? severityMatch[1]!.trim().toLowerCase() : "moderate";
      if (!severities.includes(severity)) severity = "moderate";

      const extractSection = (heading: string): string => {
        const regex = new RegExp(`^##\\s*${heading}\\s*\\r?\\n([\\s\\S]*?)(?=(?:^##\\s|\\Z))`, "mi");
        const match = regex.exec(content);
        return match ? match[1]!.trim() : "";
      };

      const fileField = extractSection("File") || "unknown";
      const userFix = extractSection("What User Fixed");
      const aiVersion = extractSection("What AI Generated");

      parsedEntries.push({
        date,
        category,
        severity,
        file: fileField,
        userFix,
        aiVersion
      });

      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
      severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
      fileCounts[fileField] = (fileCounts[fileField] ?? 0) + 1;
    } catch (err) {
      console.warn(`Warning: failed to parse feedback file ${file}: ${(err as Error).message}`);
    }
  }

  const weights = loadWeights(projectRoot) || { version: 1 as const, signals: {}, feedback: [] };

  let importedCount = 0;
  const existingFeedbackKeys = new Set(
    weights.feedback.map(fb => `${fb.ts}_${fb.prompt}`)
  );

  for (const entry of parsedEntries) {
    const lines = entry.userFix.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const summary = lines.length > 0 ? lines[0]! : "User fix";
    const cleanSummary = summary.length > 150 ? summary.substring(0, 147) + "..." : summary;

    const promptText = `Fix ${entry.category} issue in ${entry.file}: ${cleanSummary}`;
    const uniqueKey = `${entry.date}_${promptText}`;

    if (!existingFeedbackKeys.has(uniqueKey)) {
      weights.feedback.push({
        prompt: promptText,
        correctIntent: entry.category,
        ts: entry.date
      });
      existingFeedbackKeys.add(uniqueKey);
      importedCount++;
    }
  }

  if (importedCount > 0) {
    if (weights.feedback.length > 200) {
      weights.feedback = weights.feedback.slice(-200);
    }

    const signals: Record<string, number> = {};
    for (const fb of weights.feedback) {
      for (const token of tokenize(fb.prompt)) {
        const key = `${token}:${fb.correctIntent}`;
        signals[key] = (signals[key] ?? 0) + 1;
      }
    }
    weights.signals = signals;

    saveWeights(projectRoot, weights);
  }

  const sortedFiles = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]);
  
  console.log("\n=================== FEEDBACK SUMMARY ===================");
  console.log(`Total parsed feedback logs: ${parsedEntries.length}`);
  console.log("\nBy Category:");
  for (const [c, count] of Object.entries(categoryCounts)) {
    if (count > 0) console.log(`  - ${c}: ${count}`);
  }
  console.log("\nBy Severity:");
  for (const [s, count] of Object.entries(severityCounts)) {
    if (count > 0) console.log(`  - ${s}: ${count}`);
  }
  if (sortedFiles.length > 0) {
    console.log("\nTop Affected Files:");
    sortedFiles.slice(0, 3).forEach(([f, count], idx) => {
      console.log(`  ${idx + 1}. ${f} (${count} time${count > 1 ? "s" : ""})`);
    });
  }

  const topCategoryEntry = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
  if (topCategoryEntry && topCategoryEntry[1] > 0) {
    const topCategory = topCategoryEntry[0];
    const percentage = Math.round((topCategoryEntry[1] / parsedEntries.length) * 100);
    const recommendations: Record<string, string> = {
      naming: "apply naming checks from project profile before code generation.",
      logic: "improve edge-case reasoning and business rule validation.",
      style: "align generated code to surrounding file style.",
      performance: "review complexity and data access paths before final output.",
      security: "add stricter security checks before proposing code.",
      architecture: "consult decision history before suggesting structural changes.",
      other: "increase project-specific context checks prior to completion."
    };
    console.log(`\nInsight: ${percentage}% of issues are "${topCategory}".`);
    console.log(`Recommendation: ${recommendations[topCategory] || "review issues carefully."}`);
  }
  console.log("========================================================\n");

  if (importedCount > 0) {
    console.log(`Successfully imported and merged ${importedCount} new feedback entry/entries into self-learning routing weights.`);
  } else {
    console.log("All feedback logs are already imported into routing weights.");
  }
}

export function registerRouting(program: Command) {
  const routing = program
    .command("routing")
    .description("Self-learning prompt routing weights (.agency/routing-weights.json)");

  routing
    .command("weights")
    .description("Show routing weights JSON")
    .option("--project-root <path>", "Project root directory")
    .action((options: { projectRoot?: string }) => {
      const projectRoot =
        options.projectRoot ?? getWorkspaceRoot(process.cwd());
      aggregateFeedbackLogs(projectRoot);
      const weights = loadWeights(projectRoot);
      if (!weights) {
        console.error(`No weights file at ${weightsPath(projectRoot)}`);
        process.exit(1);
      }
      console.log(JSON.stringify(weights, null, 2));
    });

  routing
    .command("feedback")
    .description("Record a routing correction for self-learning weights")
    .requiredOption("--prompt <text>", "Original prompt that was misrouted")
    .requiredOption("--intent <name>", "Correct intent label")
    .option("--project-root <path>", "Project root directory")
    .action(
      (options: { prompt: string; intent: string; projectRoot?: string }) => {
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const weights = recordFeedback(
          projectRoot,
          options.prompt,
          options.intent
        );
        console.log(JSON.stringify(weights, null, 2));
      }
    );
}
