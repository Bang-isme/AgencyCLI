import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FileEditSuggestion {
  filePath: string;
  content: string;
}

export function applySearchReplace(
  fileContent: string,
  searchContent: string,
  replaceContent: string
): string {
  const normalizedFile = fileContent.replace(/\r\n/g, "\n");
  const normalizedSearch = searchContent.replace(/\r\n/g, "\n");
  const normalizedReplace = replaceContent.replace(/\r\n/g, "\n");

  if (normalizedFile.includes(normalizedSearch)) {
    return normalizedFile.replace(normalizedSearch, normalizedReplace);
  }

  const fileLines = normalizedFile.split("\n");
  const searchLines = normalizedSearch.split("\n");

  if (searchLines.length === 0 || (searchLines.length === 1 && !searchLines[0].trim())) {
    throw new Error("Search block is empty; cannot determine location to replace.");
  }

  let foundIndex = -1;
  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (fileLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
        match = false;
        break;
      }
    }
    if (match) {
      if (foundIndex !== -1) {
        throw new Error("Search block matches multiple locations in the file.");
      }
      foundIndex = i;
    }
  }

  if (foundIndex !== -1) {
    const before = fileLines.slice(0, foundIndex).join("\n");
    const after = fileLines.slice(foundIndex + searchLines.length).join("\n");
    return (before ? before + "\n" : "") + normalizedReplace + (after ? "\n" + after : "");
  }

  throw new Error("Could not find the SEARCH block in the file content.");
}

function isValidPath(filePath: string): boolean {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  const isDummy = ["example.ts", "file.ts", "filename.ts", "path/to/file", "yourfile.ts"].some(d => lower.includes(d));
  const hasDot = filePath.includes(".");
  const hasSpace = filePath.includes(" ");
  return hasDot && !hasSpace && !isDummy;
}

export function parseFileEditSuggestions(text: string, projectRoot?: string): FileEditSuggestion[] {
  const suggestionsMap = new Map<string, string>();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  
  let lastDetectedPath = "";
  let inBlock = false;
  let currentBlockPath = "";
  let currentBlockLines: string[] = [];

  let inSearch = false;
  let inReplace = false;
  let searchLines: string[] = [];
  let replaceLines: string[] = [];
  let patchPath = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle Search-and-Replace Blocks
    if (trimmed.startsWith("<<<<<<< SEARCH")) {
      inSearch = true;
      inReplace = false;
      searchLines = [];
      replaceLines = [];
      
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx !== -1) {
        patchPath = trimmed.substring(colonIdx + 1).trim();
      } else {
        patchPath = lastDetectedPath;
      }
      continue;
    }

    if (inSearch && trimmed === "=======") {
      inSearch = false;
      inReplace = true;
      continue;
    }

    if (inReplace && trimmed.startsWith(">>>>>>> REPLACE")) {
      inReplace = false;
      
      if (isValidPath(patchPath)) {
        const searchStr = searchLines.join("\n");
        const replaceStr = replaceLines.join("\n");
        
        let currentContent = "";
        if (suggestionsMap.has(patchPath)) {
          currentContent = suggestionsMap.get(patchPath)!;
        } else if (projectRoot) {
          const fullPath = join(projectRoot, patchPath);
          if (existsSync(fullPath)) {
            currentContent = readFileSync(fullPath, "utf8");
          }
        }
        
        try {
          const updatedContent = applySearchReplace(currentContent, searchStr, replaceStr);
          suggestionsMap.set(patchPath, updatedContent);
        } catch (err) {
          console.error("SEARCH/REPLACE FAILED:", err);
        }
      }
      continue;
    }

    if (inSearch) {
      searchLines.push(line);
      continue;
    }

    if (inReplace) {
      replaceLines.push(line);
      continue;
    }

    // Preceding line checks for normal code blocks
    const cleanLineForPath = trimmed.replace(/[\*#`\[\]]/g, "").trim();
    const fileMatch = cleanLineForPath.match(/^(?:(?:NEW|MODIFY|CREATE|UPDATE|File|Path|Writing to|Editing)\s*:?\s*)+([a-zA-Z0-9_.\-/\\@$]+)/i);
    if (fileMatch) {
      const candidatePath = fileMatch[1].trim();
      if (isValidPath(candidatePath)) {
        lastDetectedPath = candidatePath;
      }
    } else {
      const backtickMatch = trimmed.match(/^`([a-zA-Z0-9_.\-/\\@$]+)`$/);
      if (backtickMatch) {
        const candidatePath = backtickMatch[1].trim();
        if (isValidPath(candidatePath)) {
          lastDetectedPath = candidatePath;
        }
      }
    }

    // Handle normal markdown code blocks
    if (trimmed.startsWith("```")) {
      if (!inBlock) {
        inBlock = true;
        currentBlockLines = [];

        const openingMatch = trimmed.match(/^```([a-zA-Z0-9+#_]+)?(?:[:\s(]+([a-zA-Z0-9_.\-/\\@$]+)\)?)?/);
        if (openingMatch && openingMatch[2]) {
          currentBlockPath = openingMatch[2];
        } else {
          currentBlockPath = lastDetectedPath;
        }
      } else {
        inBlock = false;
        let filePath = currentBlockPath.trim();
        let blockContent = currentBlockLines.join("\n");

        if (!filePath && currentBlockLines.length > 0) {
          const firstLine = currentBlockLines[0].trim();
          const commentMatch = firstLine.match(/^(?:\/\/\/|\/\/|#|\/\*)\s*(?:filepath|path|file)\s*:\s*`?([a-zA-Z0-9_.\-/\\@$]+)`?\s*(?:\*\/)?/i);
          if (commentMatch) {
            filePath = commentMatch[1];
            currentBlockLines.shift();
            blockContent = currentBlockLines.join("\n");
          }
        }

        if (isValidPath(filePath)) {
          lastDetectedPath = filePath;
          suggestionsMap.set(filePath, blockContent);
        }
      }
    } else if (inBlock) {
      currentBlockLines.push(line);
    }
  }

  const suggestions: FileEditSuggestion[] = [];
  for (const [filePath, content] of suggestionsMap.entries()) {
    suggestions.push({ filePath, content });
  }
  return suggestions;
}
