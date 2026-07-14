import { loadIndex } from "../index/workspace-indexer.js";
import type { RouteResult } from "../router/model-router.js";
import { tokenize } from "../router/weights.js";
import type { TokenBudgetPlan } from "./token-policy.js";

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".gz",
  ".pdf",
  ".lock",
]);

const IMPORTANT_FILE_PATTERNS = [
  /package\.json$/i,
  /tsconfig\.json$/i,
  /readme\.md$/i,
  /app\.(tsx|ts|jsx|js)$/i,
  /index\.(tsx|ts|jsx|js)$/i,
  /main\.(tsx|ts|jsx|js)$/i,
];

function isImportantFile(path: string): boolean {
  return IMPORTANT_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function isBroadQuery(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const broadTerms = [
    "source", "code", "all files", "hết source", "toàn bộ", "cả source",
    "đọc hết", "đọc toàn bộ", "quét", "folder", "project"
  ];
  return broadTerms.some((term) => lower.includes(term));
}

function isSourceFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot).toLowerCase();
  const sourceExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".css",
    ".html",
  ]);
  return sourceExtensions.has(ext);
}

function extractIntentKeywords(route: RouteResult): Set<string> {
  const parts = [
    route.intent,
    route.workflow,
    route.suggested_agent ?? "",
    ...route.skills,
  ];
  const keywords = new Set<string>();
  for (const part of parts) {
    for (const token of tokenize(part)) {
      keywords.add(token);
    }
  }
  return keywords;
}

function scoreFilePath(path: string, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;

  const lowerPath = path.toLowerCase();
  const pathTokens = new Set(tokenize(path));
  let score = 0;

  for (const keyword of keywords) {
    if (pathTokens.has(keyword)) {
      score += 3;
    } else if (lowerPath.includes(keyword)) {
      score += 1;
    }
  }

  return score;
}

function isSelectablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return true;
  return !SKIP_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

import { execSync } from "node:child_process";
import { loadSymbolGraph } from "../index/incremental-indexer.js";

function getModifiedFilesSync(projectRoot: string): string[] {
  try {
    const output = execSync("git status --porcelain", {
      cwd: projectRoot,
      timeout: 2000,
      stdio: "pipe",
    }).toString("utf8");
    const files: string[] = [];
    for (const line of output.split("\n").filter((l) => l.length > 3)) {
      const filePathRaw = line.slice(3).trim();
      const filePath = filePathRaw.replace(/^"|"$/g, "");
      files.push(filePath);
    }
    return files;
  } catch {
    return [];
  }
}

/** Rank workspace files by route intent keywords and return top paths. */
export function selectContextFiles(
  projectRoot: string,
  route: RouteResult,
  plan: TokenBudgetPlan,
  userPrompt?: string
): string[] {
  if (plan.maxContextFiles <= 0) return [];

  const index = loadIndex(projectRoot);
  if (!index) return [];

  const keywords = extractIntentKeywords(route);
  const prompt = userPrompt ?? "";
  const isBroad = prompt ? isBroadQuery(prompt) : false;

  // Retrieve modified files and direct dependencies
  const modifiedFiles = getModifiedFilesSync(projectRoot);
  const priorityPaths = new Set<string>(modifiedFiles);
  const priorityBases = new Set<string>();

  try {
    const symbolGraph = loadSymbolGraph(projectRoot);
    for (const modFile of modifiedFiles) {
      const fileData = symbolGraph.files[modFile];
      if (fileData && fileData.imports) {
        for (const imp of fileData.imports) {
          if (imp.module.startsWith(".")) {
            const lastSlash = modFile.lastIndexOf("/");
            const modDir = lastSlash !== -1 ? modFile.slice(0, lastSlash) : "";
            const parts = modDir ? modDir.split("/") : [];
            const impParts = imp.module.split("/");
            for (const part of impParts) {
              if (part === ".") continue;
              if (part === "..") {
                parts.pop();
              } else {
                parts.push(part);
              }
            }
            const resolvedRel = parts.join("/");
            const resolvedBase = resolvedRel.replace(/\.(js|ts)x?$/, "");
            priorityBases.add(resolvedBase);
          }
        }
      }
    }
  } catch {
    // Ignore symbol graph failures
  }

  const scored = index.files
    .filter((entry) => isSelectablePath(entry.path))
    .map((entry) => {
      let score = scoreFilePath(entry.path, keywords);

      if (isBroad && isSourceFile(entry.path)) {
        score += 2;
      }

      if (isImportantFile(entry.path)) {
        score += 1;
      }

      if (route.intent === "other" && isImportantFile(entry.path)) {
        score += 3;
      }

      // Proximity & active file boosting
      const entryBase = entry.path.replace(/\.(js|ts)x?$/, "");
      if (priorityPaths.has(entry.path) || priorityBases.has(entryBase)) {
        score += 100;
      }

      // Explicitly mentioned in user prompt boost
      if (prompt && prompt.includes(entry.path)) {
        score += 50;
      }

      return {
        path: entry.path,
        score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.path.localeCompare(b.path)
    );

  return scored.slice(0, plan.maxContextFiles).map((entry) => entry.path);
}
