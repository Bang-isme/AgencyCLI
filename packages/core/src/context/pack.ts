import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRouteSummary } from "../chat/route-presentation.js";
import type { RouteResult } from "../router/model-router.js";
import { selectContextFiles } from "./selector.js";
import type { TokenBudgetPlan } from "./token-policy.js";
import { loadIndex } from "../index/workspace-indexer.js";
import { degradeWorkspaceContext } from "@agency/context";
import { resolveSkillsRoot } from "../skills-root.js";
import { parseSkillMd, resolveSkillMdPath } from "@agency/skills-bridge";
import { loadSymbolGraph, extractSymbolsAndImports } from "../index/incremental-indexer.js";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function getSymbolSignature(sourceCode: string, symbol: any): string {
  const startIdx = symbol.start;
  if (startIdx === undefined || startIdx < 0 || startIdx >= sourceCode.length) {
    return `${symbol.kind} ${symbol.name}`;
  }
  let signature = "";
  for (let i = startIdx; i < Math.min(sourceCode.length, startIdx + 300); i++) {
    const char = sourceCode[i]!;
    if (char === "{" || char === ";") {
      signature += char;
      break;
    }
    signature += char;
  }
  return signature.replace(/\s+/g, " ").trim();
}

function buildSymbolSignatures(sourceCode: string, symbols: any[]): string {
  if (!symbols || symbols.length === 0) return "// No symbol declarations found.";

  const lines: string[] = ["// Structural outline of symbols (signatures only):"];
  const sortedSymbols = [...symbols].sort((a, b) => a.start - b.start);

  for (const sym of sortedSymbols) {
    if (sym.kind === "method" && sym.className) {
      const sig = getSymbolSignature(sourceCode, sym);
      lines.push(`  ${sig}`);
    } else {
      const sig = getSymbolSignature(sourceCode, sym);
      lines.push(sig);
    }
  }

  return lines.join("\n");
}

interface TreeNode {
  name: string;
  isFile: boolean;
  size?: number;
  children: Map<string, TreeNode>;
}

export function buildFileTreeSection(projectRoot: string, maxFiles = 200): string {
  const index = loadIndex(projectRoot);
  if (!index || !index.files || index.files.length === 0) {
    return "";
  }

  const files = index.files.slice(0, maxFiles);
  const isTruncated = index.files.length > maxFiles;

  const rootNode: TreeNode = { name: ".", isFile: false, children: new Map() };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = rootNode;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          isFile: isLast,
          size: isLast ? file.size : undefined,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }
  }

  const lines: string[] = ["## Workspace File Tree", ""];

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function render(node: TreeNode, depth: number) {
    const indent = "  ".repeat(depth);
    if (node.name !== ".") {
      if (node.isFile) {
        lines.push(`${indent}- ${node.name} (${formatSize(node.size ?? 0)})`);
      } else {
        lines.push(`${indent}- ${node.name}/`);
      }
    }
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      if (a.isFile !== b.isFile) {
        return a.isFile ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const child of sortedChildren) {
      render(child, node.name === "." ? depth : depth + 1);
    }
  }

  render(rootNode, 0);

  if (isTruncated) {
    lines.push("", `... and ${index.files.length - maxFiles} more files.`);
  }

  return lines.join("\n");
}

/** Build a compact markdown context block for LLM injection. */
export function buildContextPack(
  projectRoot: string,
  route: RouteResult,
  plan: TokenBudgetPlan
): string {
  const sections: string[] = ["# Context", "", formatRouteSummary(route)];

  const treeSection = buildFileTreeSection(projectRoot);
  if (treeSection) {
    sections.push("", treeSection);
  }

  // Load active skills guidelines
  const activeSkillsGuidelines: string[] = [];
  if (route.skills && route.skills.length > 0) {
    try {
      const skillsRoot = resolveSkillsRoot();
      for (const skillName of route.skills) {
        try {
          const mdPath = resolveSkillMdPath(skillsRoot, skillName);
          if (existsSync(mdPath)) {
            const parsed = parseSkillMd(mdPath);
            activeSkillsGuidelines.push(`### Skill: ${parsed.name}\nDescription: ${parsed.description}\n\n${parsed.body}`);
          }
        } catch {
          // Skip missing skill guides
        }
      }
    } catch {
      // Ignore if skills root can't be resolved
    }
  }

  if (activeSkillsGuidelines.length > 0) {
    sections.push("", "# ACTIVE SKILLS GUIDELINES", "", ...activeSkillsGuidelines);
  }

  const files = selectContextFiles(projectRoot, route, plan);
  if (files.length === 0) {
    return truncateText(sections.join("\n"), plan.maxContextChars);
  }

  const symbolGraph = loadSymbolGraph(projectRoot);

  // Load all selected files in memory first
  const filesContent = new Map<string, string>();
  for (let i = 0; i < files.length; i++) {
    const relPath = files[i]!;
    const fullPath = join(projectRoot, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf8");
        const isPrimary = i < 3;
        const isTsOrJs = /\.(?:ts|tsx|js|jsx)$/i.test(relPath);

        if (isPrimary || !isTsOrJs) {
          filesContent.set(relPath, content);
        } else {
          let fileData = symbolGraph.files[relPath];
          if (!fileData) {
            fileData = extractSymbolsAndImports(content, relPath);
          }
          const outline = buildSymbolSignatures(content, fileData.symbols);
          filesContent.set(relPath, outline);
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }

  // Calculate base overhead length
  const baseLength = sections.join("\n").length + 50; // extra padding
  const remainingBudget = plan.maxContextChars - baseLength;

  // Run the degradation engine
  const degradedFiles = degradeWorkspaceContext(filesContent, Math.max(0, remainingBudget));

  sections.push("", "## Files");

  for (const [relPath, content] of degradedFiles.entries()) {
    const header = `### ${relPath}`;
    const fenceOpen = "```";
    const overhead =
      sections.join("\n").length +
      1 +
      header.length +
      1 +
      fenceOpen.length +
      1 +
      fenceOpen.length +
      1;

    const remaining = plan.maxContextChars - overhead;
    if (remaining <= 0) break;

    let finalContent = content;
    if (finalContent.length > remaining) {
      finalContent = truncateText(finalContent, Math.max(0, remaining));
    }

    sections.push("", header, fenceOpen, finalContent, fenceOpen);
    if (sections.join("\n").length >= plan.maxContextChars) break;
  }

  return truncateText(sections.join("\n"), plan.maxContextChars);
}
