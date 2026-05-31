import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndex,
  loadIndex,
  writeIndex,
  type WorkspaceIndex,
} from "../index/workspace-indexer.js";

const MAX_REF_CHARS_PER_FILE = 32000;
const MAX_REF_FILES = 10;


/** Extract `@path` tokens from a prompt (no spaces in path). */
export function parseAtReferences(prompt: string): string[] {
  const refs = new Set<string>();
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const path = m[1]?.trim();
    if (path) refs.add(path.replace(/\\/g, "/"));
  }
  return [...refs];
}

function scoreFuzzy(path: string, query: string): number {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (p === q) return 100;
  if (p.endsWith(q)) return 80;
  if (p.includes(q)) return 50 + q.length;
  let qi = 0;
  for (const ch of p) {
    if (ch === q[qi]) qi++;
    if (qi >= q.length) return 20 + qi;
  }
  return 0;
}

function ensureIndex(projectRoot: string): WorkspaceIndex {
  const existing = loadIndex(projectRoot);
  if (existing) return existing;
  const built = buildIndex(projectRoot);
  writeIndex(projectRoot, built);
  return built;
}

/** Fuzzy file search for `@` autocomplete (uses `.agency/index.json`, builds if missing). */
export function fuzzySearchFiles(
  projectRoot: string,
  query: string,
  limit = 8
): string[] {
  const index = ensureIndex(projectRoot);
  const q = query.replace(/^@/, "").trim();
  return index.files
    .map((f) => ({ path: f.path, score: scoreFuzzy(f.path, q) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((e) => e.path);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Read explicit `@` paths and return a markdown block for LLM context. */
export function buildAtReferenceContext(
  projectRoot: string,
  refs: string[],
  maxChars = 12000
): { block: string; resolved: string[]; missing: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const sections: string[] = ["## Referenced files (@)"];

  for (const rel of refs.slice(0, MAX_REF_FILES)) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) {
      missing.push(rel);
      continue;
    }
    let content = readFileSync(full, "utf8");
    content = truncate(content, MAX_REF_CHARS_PER_FILE);
    sections.push("", `### ${rel}`, "```", content, "```");
    resolved.push(rel);
    if (sections.join("\n").length >= maxChars) break;
  }

  const block = truncate(sections.join("\n"), maxChars);
  return { block, resolved, missing };
}

/** Resolves all explicit (@) and implicit file references from a prompt. */
export function resolveAllFileReferences(prompt: string, projectRoot: string): string[] {
  const resolved = new Set<string>();

  // 1. Explicit @ references
  const atRefs = parseAtReferences(prompt);
  for (const ref of atRefs) {
    if (existsSync(join(projectRoot, ref))) {
      resolved.add(ref.replace(/\\/g, "/"));
    } else {
      // Try to find it in the index by name or suffix
      const index = ensureIndex(projectRoot);
      const matched = index.files.find(
        (f) =>
          f.path.endsWith(ref) ||
          f.path.toLowerCase().endsWith(ref.toLowerCase())
      );
      if (matched) {
        resolved.add(matched.path);
      }
    }
  }

  // 1.5. Intent-based patterns for "read file X", "xem file X", "show me X", etc.
  const readIntentRegexes = [
    /(?:đọc|xem)\s+(?:file|tệp\s+tin)?\s*[:"'\`]?\s*([a-zA-Z0-9_\-\.\/\\+]+)/gi,
    /(?:read|show|open)\s+(?:file)?\s*[:"'\`]?\s*([a-zA-Z0-9_\-\.\/\\+]+)/gi,
  ];

  for (const regex of readIntentRegexes) {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(prompt)) !== null) {
      const ref = match[1]?.trim();
      if (ref) {
        const cleanRef = ref.replace(/["'\`\:\,\.\;\)\}\]]+$/, "").replace(/^[\[\(\{\s"'\`]+/, "");
        if (cleanRef) {
          if (resolved.has(cleanRef)) continue;
          
          const fullPath = join(projectRoot, cleanRef);
          if (existsSync(fullPath)) {
            resolved.add(cleanRef.replace(/\\/g, "/"));
          } else {
            const index = ensureIndex(projectRoot);
            let matched = index.files.find((f) => f.path.toLowerCase() === cleanRef.toLowerCase());
            if (!matched) {
              matched = index.files.find((f) => f.path.toLowerCase().endsWith("/" + cleanRef.toLowerCase()));
            }
            if (!matched) {
              matched = index.files.find((f) => f.path.split("/").pop()?.toLowerCase() === cleanRef.toLowerCase());
            }
            if (!matched) {
              matched = index.files.find((f) => {
                const dot = f.path.lastIndexOf(".");
                const nameNoExt = dot !== -1 ? f.path.substring(0, dot) : f.path;
                if (nameNoExt.toLowerCase() === cleanRef.toLowerCase()) return true;
                if (nameNoExt.toLowerCase().endsWith("/" + cleanRef.toLowerCase())) return true;
                
                const base = f.path.split("/").pop() || "";
                const baseDot = base.lastIndexOf(".");
                const baseNoExt = baseDot !== -1 ? base.substring(0, baseDot) : base;
                return baseNoExt.toLowerCase() === cleanRef.toLowerCase();
              });
            }
            if (matched) {
              resolved.add(matched.path);
            }
          }
        }
      }
    }
  }

  // 2. Implicit references (extract potential paths/filenames from prompt)
  const words = prompt.split(/[\s"'\`\(\)\[\]\{\},;]+/);
  const commonExtensions = new Set([
    "ts", "tsx", "js", "jsx", "json", "py", "md", "css", "html", "sh", "yaml", "yml", "txt", "rs", "go"
  ]);

  for (const word of words) {
    let clean = word.replace(/[.,:;?!\(\)\]\}]+$/, "").replace(/^[\[\(\{\s]+/, "");
    if (!clean) continue;

    clean = clean.replace(/\\/g, "/");

    if (resolved.has(clean)) continue;

    const fullPath = join(projectRoot, clean);
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          resolved.add(clean);
          continue;
        }
      } catch {
        // Ignore read/stat errors
      }
    }

    const dotIdx = clean.lastIndexOf(".");
    if (dotIdx !== -1) {
      const ext = clean.substring(dotIdx + 1).toLowerCase();
      if (commonExtensions.has(ext)) {
        const index = ensureIndex(projectRoot);
        let matched = index.files.find((f) => f.path.toLowerCase() === clean.toLowerCase());
        if (!matched) {
          matched = index.files.find((f) => f.path.toLowerCase().endsWith("/" + clean.toLowerCase()));
        }
        if (!matched) {
          matched = index.files.find((f) => f.path.split("/").pop()?.toLowerCase() === clean.toLowerCase());
        }
        if (matched) {
          resolved.add(matched.path);
        }
      }
    } else {
      const index = ensureIndex(projectRoot);
      const cleanLower = clean.toLowerCase();
      const matched = index.files.find((f) => {
        const dot = f.path.lastIndexOf(".");
        const pathWithoutExt = dot !== -1 ? f.path.substring(0, dot) : f.path;

        if (pathWithoutExt.toLowerCase() === cleanLower) return true;
        if (pathWithoutExt.toLowerCase().endsWith("/" + cleanLower)) return true;

        const parts = f.path.split("/");
        const base = parts[parts.length - 1];
        const baseDot = base.lastIndexOf(".");
        const nameWithoutExt = baseDot !== -1 ? base.substring(0, baseDot) : base;
        if (nameWithoutExt.toLowerCase() === cleanLower) return true;

        return false;
      });
      if (matched) {
        resolved.add(matched.path);
      }
    }
  }

  return [...resolved];
}

