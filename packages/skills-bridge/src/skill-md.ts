import { readFileSync } from "node:fs";

export interface ParsedSkillMd {
  name: string;
  description: string;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function parseYamlField(block: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  return block.match(re)?.[1]?.trim() ?? "";
}

export function parseSkillMd(path: string): ParsedSkillMd {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`Invalid SKILL.md frontmatter at ${path}`);
  }

  const frontmatter = match[1];
  const body = match[2];
  const name = parseYamlField(frontmatter, "name");
  const description = parseYamlField(frontmatter, "description");

  if (!name) {
    throw new Error(`SKILL.md missing name in frontmatter at ${path}`);
  }

  return { name, description, body };
}

export function extractTldr(body: string): string | null {
  const match = body.match(/## TL;DR\r?\n([\s\S]*?)(?=\r?\n## |\r?\n# |$)/);
  return match?.[1]?.trim() ?? null;
}
