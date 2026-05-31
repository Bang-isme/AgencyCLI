import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Always-skip directories regardless of .gitignore */
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist", ".agency", "__pycache__", ".next", ".nuxt", ".svelte-kit"]);

interface IgnoreRule {
  pattern: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * Parse a single .gitignore line into a rule.
 * Returns null for comments and blanks.
 */
function parseLine(line: string): IgnoreRule | null {
  let trimmed = line.trimEnd();
  if (!trimmed || trimmed.startsWith("#")) return null;

  // Leading whitespace is significant in gitignore
  let negated = false;
  if (trimmed.startsWith("!")) {
    negated = true;
    trimmed = trimmed.slice(1);
  }

  // Trailing slash means directory-only
  const dirOnly = trimmed.endsWith("/");
  if (dirOnly) {
    trimmed = trimmed.slice(0, -1);
  }

  // Convert gitignore glob to regex
  const regex = globToRegex(trimmed);
  return { pattern: regex, negated, dirOnly };
}

/**
 * Convert a gitignore glob pattern to a regex.
 * Supports: *, **, ?, [chars], leading /
 */
function globToRegex(glob: string): RegExp {
  let anchored = false;
  let g = glob;

  // Leading slash → anchored to root
  if (g.startsWith("/")) {
    anchored = true;
    g = g.slice(1);
  }

  // If pattern contains no slash (other than leading), match basename
  const hasSlash = g.includes("/");

  let regexStr = "";
  let i = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          // **/ matches zero or more directories
          regexStr += "(?:.+/)?";
          i += 3;
          continue;
        }
        // ** at end matches everything
        regexStr += ".*";
        i += 2;
        continue;
      }
      // Single * matches anything except /
      regexStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = g.indexOf("]", i + 1);
      if (close === -1) {
        regexStr += "\\[";
        i++;
      } else {
        regexStr += g.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === ".") {
      regexStr += "\\.";
      i++;
    } else if (ch === "/") {
      regexStr += "/";
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  if (anchored || hasSlash) {
    // Match from start of path
    return new RegExp(`^${regexStr}(?:$|/)`);
  }
  // Match basename or any nested path
  return new RegExp(`(?:^|/)${regexStr}(?:$|/)`);
}

export class IgnoreFilter {
  private rules: IgnoreRule[] = [];

  constructor(lines?: string[]) {
    if (lines) {
      this.addLines(lines);
    }
  }

  addLines(lines: string[]): void {
    for (const line of lines) {
      const rule = parseLine(line);
      if (rule) this.rules.push(rule);
    }
  }

  /**
   * Check if a relative path should be ignored.
   * @param relPath — forward-slash separated relative path
   * @param isDir — whether the path is a directory
   */
  isIgnored(relPath: string, isDir: boolean): boolean {
    // Always skip hardcoded dirs
    const parts = relPath.split("/");
    if (parts.some((p) => ALWAYS_SKIP.has(p))) return true;

    const normalized = relPath.replace(/\\/g, "/");
    let ignored = false;

    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.pattern.test(normalized)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }
}

/**
 * Load all .gitignore and .agencyignore files from project root.
 * Returns a single IgnoreFilter combining all rules.
 */
export function loadIgnoreFilter(projectRoot: string): IgnoreFilter {
  const filter = new IgnoreFilter();

  // Load .gitignore
  const gitignorePath = join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8");
    filter.addLines(content.split("\n"));
  }

  // Load .agencyignore (project-specific overrides)
  const agencyignorePath = join(projectRoot, ".agencyignore");
  if (existsSync(agencyignorePath)) {
    const content = readFileSync(agencyignorePath, "utf8");
    filter.addLines(content.split("\n"));
  }

  return filter;
}

/**
 * Check if a directory name should always be skipped (fast path).
 */
export function isAlwaysSkipped(dirName: string): boolean {
  return ALWAYS_SKIP.has(dirName);
}
