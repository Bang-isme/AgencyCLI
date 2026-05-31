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
