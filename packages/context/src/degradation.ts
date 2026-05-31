/**
 * Context Degradation Engine (Tier 2)
 *
 * Implements a lightweight, language-agnostic signature scanning and body collapsing
 * algorithm to fit large dependency codebases into tight context budgets.
 */

export interface DegradationOptions {
  /** Maximum token/char limit for the file. */
  maxChars?: number;
  /** Keep imports at the top. */
  keepImports?: boolean;
}

/**
 * Strips out function, method, and constructor bodies from TypeScript/JavaScript/JSON-like code.
 * Replaces function bodies with `{ \/* collapsed *\/ }`.
 */
export function degradeCode(code: string, filePath?: string): string {
  // If it's a JSON file, don't degrade it as it represents data.
  if (filePath?.endsWith(".json")) {
    return code;
  }

  let result = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];

    // Handle single-line comments
    if (ch === "/" && code[i + 1] === "/") {
      result += "//";
      i += 2;
      while (i < n && code[i] !== "\n") {
        result += code[i];
        i++;
      }
      continue;
    }

    // Handle multi-line comments
    if (ch === "/" && code[i + 1] === "*") {
      result += "/*";
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        result += code[i];
        i++;
      }
      if (i < n) {
        result += "*/";
        i += 2;
      }
      continue;
    }

    // Handle single/double quoted strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      result += quote;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === "\\") {
          result += "\\" + (code[i + 1] || "");
          i += 2;
        } else {
          result += code[i];
          i++;
        }
      }
      if (i < n) {
        result += quote;
        i++;
      }
      continue;
    }

    // Handle template literals
    if (ch === "`") {
      result += "`";
      i++;
      while (i < n && code[i] !== "`") {
        if (code[i] === "\\") {
          result += "\\" + (code[i + 1] || "");
          i += 2;
        } else {
          result += code[i];
          i++;
        }
      }
      if (i < n) {
        result += "`";
        i++;
      }
      continue;
    }

    // Handle open curly brace `{`
    if (ch === "{") {
      // Find what precedes this `{` to decide if it is a function/method body
      const backtrackLimit = Math.max(0, result.lastIndexOf(";"), result.lastIndexOf("{"), result.lastIndexOf("}"));
      const precedingText = result.slice(backtrackLimit);

      const hasParens = precedingText.includes(")");
      const hasArrow = precedingText.includes("=>");
      const hasConstructor = /\bconstructor\b/.test(precedingText);

      // Exclude keywords like if, for, while, catch, switch, with
      const isControlFlow = /\b(if|for|while|catch|switch|with)\b/.test(precedingText);

      if ((hasParens || hasArrow || hasConstructor) && !isControlFlow) {
        // Yes, it is a function/method body! Let's skip to the matching `}`
        let depth = 1;
        i++; // skip `{`
        
        while (i < n && depth > 0) {
          const innerCh = code[i];
          if (innerCh === "/" && code[i + 1] === "/") {
            i += 2;
            while (i < n && code[i] !== "\n") i++;
          } else if (innerCh === "/" && code[i + 1] === "*") {
            i += 2;
            while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
            if (i < n) i += 2;
          } else if (innerCh === "'" || innerCh === '"') {
            const q = innerCh;
            i++;
            while (i < n && code[i] !== q) {
              if (code[i] === "\\") i += 2;
              else i++;
            }
            if (i < n) i++;
          } else if (innerCh === "`") {
            i++;
            while (i < n && code[i] !== "`") {
              if (code[i] === "\\") i += 2;
              else i++;
            }
            if (i < n) i++;
          } else if (innerCh === "{") {
            depth++;
            i++;
          } else if (innerCh === "}") {
            depth--;
            i++;
          } else {
            i++;
          }
        }
        
        result += "{ /* collapsed */ }";
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * High-level degradation pipeline. Degrades context files when character count
 * exceeds budget thresholds.
 */
export function degradeWorkspaceContext(
  filesContent: Map<string, string>,
  maxBudgetChars: number
): Map<string, string> {
  const degraded = new Map<string, string>();
  let totalChars = 0;

  // Calculate current size
  for (const [path, content] of filesContent.entries()) {
    totalChars += content.length;
    degraded.set(path, content);
  }

  // If size is within budget, no degradation is needed
  if (totalChars <= maxBudgetChars) {
    return degraded;
  }

  // Degrade Tier 2 files (we'll treat all files except maybe the primary/first file as Tier 2)
  const sortedPaths = Array.from(filesContent.keys());
  
  // Keep the first file fully active (Tier 1), degrade the rest (Tier 2)
  for (let idx = 1; idx < sortedPaths.length; idx++) {
    const path = sortedPaths[idx]!;
    const original = filesContent.get(path)!;
    const collapsed = degradeCode(original, path);
    degraded.set(path, collapsed);
    
    // Check if we are now under budget
    let currentTotal = 0;
    for (const content of degraded.values()) {
      currentTotal += content.length;
    }
    if (currentTotal <= maxBudgetChars) {
      break;
    }
  }

  return degraded;
}
