import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { loadIndex, incrementalUpdateAsync, writeIndex } from "../index/workspace-indexer.js";
import { loadSymbolGraph, updateFileInSymbolGraph, extractSymbolsAndImports, saveSymbolGraph } from "../index/incremental-indexer.js";
import { detectLanguage, isBinaryExtension } from "../index/language-map.js";
import { IngestionPipeline } from "@agency/memory";

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function buildKnowledgeGraph(projectRoot: string): Promise<void> {
  const index = loadIndex(projectRoot);
  if (!index) return;

  const symbolGraph = loadSymbolGraph(projectRoot);
  let symbolGraphChanged = false;

  for (const fileEntry of index.files) {
    const posixPath = toPosixPath(fileEntry.path);
    const lang = detectLanguage(posixPath);
    if (!lang || isBinaryExtension(posixPath)) {
      continue;
    }

    const fullPath = join(projectRoot, fileEntry.path);
    if (!existsSync(fullPath)) continue;

    const existingData = symbolGraph.files[fileEntry.path];
    const needsUpdate = !existingData || (fileEntry.contentHash && existingData.hash !== fileEntry.contentHash);

    if (needsUpdate) {
      try {
        const sourceCode = readFileSync(fullPath, "utf8");
        const fileData = extractSymbolsAndImports(sourceCode, fileEntry.path);
        symbolGraph.files[fileEntry.path] = fileData;
        symbolGraphChanged = true;
      } catch {
        // Skip files that fail to read/parse
      }
    }
  }

  if (symbolGraphChanged) {
    saveSymbolGraph(projectRoot, symbolGraph);
  }

  const allFiles = new Set(index.files.map(f => toPosixPath(f.path)));

  const fileDependencies: Record<string, string[]> = {};
  const entrypoints: Array<{ id: string; label: string; kind: "file" | "module" | "route" | "model" }> = [];

  let routeCount = 0;
  let modelCount = 0;

  for (const [filePath, fileData] of Object.entries(symbolGraph.files)) {
    const posixPath = toPosixPath(filePath);
    if (!allFiles.has(posixPath)) continue;

    // Resolve dependencies
    const deps = new Set<string>();
    if (fileData.imports) {
      for (const imp of fileData.imports) {
        if (imp.module.startsWith(".")) {
          const importerExt = posixPath.split(".").pop();
          const candidateBase = join(dirname(posixPath), imp.module);
          const candidates: string[] = [
            normalize(candidateBase),
          ];
          if (imp.module.includes(".")) {
            candidates.push(normalize(candidateBase));
          } else {
            if (importerExt) {
              candidates.push(normalize(candidateBase + "." + importerExt));
              if (importerExt === "py") {
                candidates.push(normalize(candidateBase + "/__init__.py"));
              } else {
                candidates.push(normalize(candidateBase + "/index." + importerExt));
              }
            }
            candidates.push(
              normalize(candidateBase + ".ts"),
              normalize(candidateBase + ".tsx"),
              normalize(candidateBase + ".js"),
              normalize(candidateBase + ".jsx"),
              normalize(candidateBase + "/index.ts"),
              normalize(candidateBase + "/index.tsx"),
              normalize(candidateBase + "/index.js")
            );
          }
          const posixCandidates = candidates.map(p => toPosixPath(p));

          for (const cand of posixCandidates) {
            if (allFiles.has(cand)) {
              deps.add(cand);
              break;
            }
          }
        }
      }
    }

    if (deps.size > 0) {
      fileDependencies[posixPath] = Array.from(deps);
    }

    // Determine entrypoints and kinds
    const isIndex = /(?:index|main|app|cli)\.[a-z0-9]+$/i.test(posixPath) && !posixPath.endsWith(".md") && !posixPath.endsWith(".json");
    const hasEndpoints = fileData.semanticFindings && fileData.semanticFindings.endpoints > 0;
    const isModel = /(?:models?|schemas?|entities?|types?)\.[a-z0-9]+$/i.test(posixPath) || 
                    posixPath.includes("/models/") || 
                    posixPath.includes("/types/") || 
                    posixPath.includes("/entities/") || 
                    posixPath.includes("/schemas/");

    if (hasEndpoints) {
      routeCount++;
      entrypoints.push({
        id: posixPath,
        label: posixPath.split("/").pop() ?? posixPath,
        kind: "route"
      });
    } else if (isModel) {
      modelCount++;
      entrypoints.push({
        id: posixPath,
        label: posixPath.split("/").pop() ?? posixPath,
        kind: "model"
      });
    } else if (isIndex) {
      entrypoints.push({
        id: posixPath,
        label: posixPath.split("/").pop() ?? posixPath,
        kind: "module"
      });
    }
  }

  // Build export map for tracing heritage and function call targets
  const exportMap = new Map<string, string>();
  for (const [filePath, fileData] of Object.entries(symbolGraph.files)) {
    const posixPath = toPosixPath(filePath);
    if (!allFiles.has(posixPath)) continue;
    if (fileData.exports) {
      for (const exp of fileData.exports) {
        exportMap.set(exp, posixPath);
      }
    }
  }

  const heritageEdges: Array<{ from: string; to: string; kind: "extends" | "implements"; className: string; parentName: string }> = [];
  const callEdges: Array<{ from: string; to: string; kind: "call"; functionName: string }> = [];

  for (const [filePath, fileData] of Object.entries(symbolGraph.files)) {
    const posixPath = toPosixPath(filePath);
    if (!allFiles.has(posixPath)) continue;

    if (fileData.heritage) {
      for (const h of fileData.heritage) {
        const targetFile = exportMap.get(h.parentName);
        if (targetFile && targetFile !== posixPath) {
          heritageEdges.push({
            from: posixPath,
            to: targetFile,
            kind: h.kind,
            className: h.className,
            parentName: h.parentName,
          });
        }
      }
    }

    if (fileData.calls) {
      for (const callName of fileData.calls) {
        const targetFile = exportMap.get(callName);
        if (targetFile && targetFile !== posixPath) {
          callEdges.push({
            from: posixPath,
            to: targetFile,
            kind: "call",
            functionName: callName,
          });
        }
      }
    }
  }



  const totalSize = index.files.reduce((acc, f) => acc + (f.size || 0), 0);

  // --- Build rich codebase telemetry index ---
  const codeIndex: Record<string, any> = {};
  const allPosixFiles = Array.from(allFiles);

  // We will build imported_by relationship map
  const importedByMap = new Map<string, string[]>();
  allPosixFiles.forEach(f => importedByMap.set(f, []));

  // Determine local imports for each file to compute imported_by
  for (const [filePath, fileData] of Object.entries(symbolGraph.files)) {
    const posixPath = toPosixPath(filePath);
    if (!allFiles.has(posixPath)) continue;

    const deps = new Set<string>();
    if (fileData.imports) {
      for (const imp of fileData.imports) {
        if (imp.module.startsWith(".")) {
          const importerExt = posixPath.split(".").pop();
          const candidateBase = join(dirname(posixPath), imp.module);
          const candidates: string[] = [
            normalize(candidateBase),
          ];
          if (imp.module.includes(".")) {
            candidates.push(normalize(candidateBase));
          } else {
            if (importerExt) {
              candidates.push(normalize(candidateBase + "." + importerExt));
              if (importerExt === "py") {
                candidates.push(normalize(candidateBase + "/__init__.py"));
              } else {
                candidates.push(normalize(candidateBase + "/index." + importerExt));
              }
            }
            candidates.push(
              normalize(candidateBase + ".ts"),
              normalize(candidateBase + ".tsx"),
              normalize(candidateBase + ".js"),
              normalize(candidateBase + ".jsx"),
              normalize(candidateBase + "/index.ts"),
              normalize(candidateBase + "/index.tsx"),
              normalize(candidateBase + "/index.js")
            );
          }
          const posixCandidates = candidates.map(p => toPosixPath(p));

          for (const cand of posixCandidates) {
            if (allFiles.has(cand)) {
              deps.add(cand);
              importedByMap.get(cand)?.push(posixPath);
              break;
            }
          }
        }
      }
    }
  }

  const getLinesCount = (filePath: string): number => {
    try {
      const fullPath = join(projectRoot, filePath);
      if (existsSync(fullPath)) {
        return readFileSync(fullPath, "utf8").split("\n").length;
      }
    } catch {}
    return 100;
  };

  const isTestFile = (path: string): boolean => {
    const l = path.toLowerCase();
    return l.includes("test") || l.includes("__tests__") || l.endsWith(".test.ts") || l.endsWith(".spec.ts") || l.endsWith(".test.tsx") || l.endsWith(".spec.tsx");
  };

  const isEntryPointFile = (path: string): boolean => {
    return /(?:index|main|app|cli)\.(?:ts|tsx|js|jsx)$/i.test(path);
  };

  function getModuleFromPath(posixPath: string): string {
    const parts = posixPath.split("/");
    if (parts[0] === "packages" && parts.length > 2) {
      if (parts[2] === "src" && parts.length > 3) {
        return `${parts[1]}/${parts[3]}`;
      }
      return parts[1];
    }
    if (parts.length > 1) {
      if (parts[0] === "src" && parts.length > 2) {
        return parts[1];
      }
      return parts[0];
    }
    return "root";
  }

  const externalDependencies: Record<string, { used_by: string[] }> = {};
  const riskSignals: Array<{ type: string; file: string; reason: string }> = [];
  const apiRoutes: Array<{ method: string; path: string; handler: string; file: string; models: string[] }> = [];
  const dataModels: Record<string, any> = {};

  for (const fileEntry of index.files) {
    const posixPath = toPosixPath(fileEntry.path);
    const fileSymbolData = symbolGraph.files[fileEntry.path] || { filePath: fileEntry.path, hash: "", symbols: [], imports: [] };
    const fileLines = getLinesCount(fileEntry.path);

    const definitions = fileSymbolData.exports || fileSymbolData.symbols
      ?.filter(s => s.kind === "class" || s.kind === "function" || s.kind === "interface")
      ?.map(s => s.name) || [];

    const localImports = fileDependencies[posixPath] || [];
    const importedBy = importedByMap.get(posixPath) || [];

    const externalImports: string[] = [];
    if (fileSymbolData.imports) {
      for (const imp of fileSymbolData.imports) {
        if (!imp.module.startsWith(".")) {
          const cleanPkg = imp.module.startsWith("@")
            ? imp.module.split("/").slice(0, 2).join("/")
            : imp.module.split("/")[0]!;
          if (!externalImports.includes(cleanPkg)) {
            externalImports.push(cleanPkg);
            if (!externalDependencies[cleanPkg]) {
              externalDependencies[cleanPkg] = { used_by: [] };
            }
            if (!externalDependencies[cleanPkg].used_by.includes(posixPath)) {
              externalDependencies[cleanPkg].used_by.push(posixPath);
            }
          }
        }
      }
    }

    const riskTags: string[] = [];
    let fileContent = "";
    try {
      const fullPath = join(projectRoot, fileEntry.path);
      if (existsSync(fullPath)) {
        fileContent = readFileSync(fullPath, "utf8");
      }
    } catch {}

    const hasAuthToken = /token|password|secret|auth|jwt|credential/i.test(fileContent) || /token|password|secret|auth|jwt|credential/i.test(posixPath);
    if (hasAuthToken && !isTestFile(posixPath)) {
      riskTags.push("auth_or_secret_logic");
      riskSignals.push({
        type: "auth_or_secret_logic",
        file: posixPath,
        reason: "File contains sensitive authentication, token, JWT or password related logic. Verify credential handling."
      });
    }

    const hasDangerousSink = /eval\s*\(|exec\s*\(|execSync\s*\(|spawn\s*\(|child_process/i.test(fileContent);
    if (hasDangerousSink) {
      riskTags.push("dangerous_sink");
      riskSignals.push({
        type: "dangerous_sink",
        file: posixPath,
        reason: "File executes shell scripts, invokes subprocesses or calls eval. Validate user-controlled inputs."
      });
    }

    if (fileLines > 1000 || (fileEntry.size || 0) > 200_000) {
      riskTags.push("large_file");
      riskSignals.push({
        type: "large_file",
        file: posixPath,
        reason: `File size is exceptionally heavy: ${fileLines} lines (${Math.round((fileEntry.size || 0) / 1024)} KB). Consider code-splitting.`
      });
    }

    if (fileSymbolData.semanticFindings && fileSymbolData.semanticFindings.endpoints > 0) {
      let detectedEndpoints = 0;
      if (posixPath.endsWith(".py")) {
        // FastAPI
        const fastapiRegex = /@(?:app|router|api)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
        let match;
        while ((match = fastapiRegex.exec(fileContent)) !== null) {
          const method = match[1]!.toUpperCase();
          const path = match[2]!;
          const rest = fileContent.substring(fastapiRegex.lastIndex);
          const defMatch = /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(rest);
          const handler = defMatch ? defMatch[1]! : "handler";
          apiRoutes.push({ method, path, handler, file: posixPath, models: [] });
          detectedEndpoints++;
        }

        // Flask
        const flaskRegex = /@(?:app|router|api)\.route\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/gi;
        while ((match = flaskRegex.exec(fileContent)) !== null) {
          const path = match[1]!;
          const methodsStr = match[2];
          const methods = methodsStr
            ? methodsStr.replace(/['"\s]/g, "").split(",")
            : ["GET"];
          const rest = fileContent.substring(flaskRegex.lastIndex);
          const defMatch = /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(rest);
          const handler = defMatch ? defMatch[1]! : "handler";
          for (const m of methods) {
            apiRoutes.push({ method: m.toUpperCase(), path, handler, file: posixPath, models: [] });
            detectedEndpoints++;
          }
        }
      } else {
        const routeRegexes = [
          /\b(?:app|router|server|fastify|instance)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
          /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
          /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/g
        ];

        for (const rx of routeRegexes) {
          let match;
          rx.lastIndex = 0;
          while ((match = rx.exec(fileContent)) !== null) {
            const method = (match[1] || "GET").toUpperCase();
            let path = match[2];
            if (!path) {
              const matchNextApi = posixPath.match(/(?:app|pages)\/api\/(.+)\.(?:ts|tsx|js|jsx)$/);
              if (matchNextApi) {
                path = `/api/${matchNextApi[1]?.replace(/\/route$/, "")}`;
              } else {
                path = "/api-route";
              }
            }
            apiRoutes.push({
              method,
              path,
              handler: definitions[0] || "handler",
              file: posixPath,
              models: []
            });
            detectedEndpoints++;
          }
        }
      }

      if (detectedEndpoints === 0) {
        let fallbackPath = `/${getModuleFromPath(posixPath)}/${posixPath.split("/").pop()?.split(".")[0] || "endpoint"}`;
        const matchNextApi = posixPath.match(/(?:app|pages)\/api\/(.+)\.(?:ts|tsx|js|jsx)$/);
        if (matchNextApi) {
          fallbackPath = `/api/${matchNextApi[1]?.replace(/\/route$/, "")}`;
        }
        apiRoutes.push({
          method: "GET",
          path: fallbackPath,
          handler: definitions[0] || "handler",
          file: posixPath,
          models: []
        });
      }
    }

    const isModelFile = /(?:models?|schemas?|entities?|types?)\.[a-z0-9]+$/i.test(posixPath) || 
                        posixPath.endsWith(".prisma") ||
                        posixPath.endsWith(".go") ||
                        posixPath.endsWith(".rs") ||
                        posixPath.includes("/models/") || 
                        posixPath.includes("/types/") || 
                        posixPath.includes("/entities/") || 
                        posixPath.includes("/schemas/");
    if (isModelFile && !isTestFile(posixPath)) {
      if (posixPath.endsWith(".prisma")) {
        // Prisma schema parser
        const modelRegex = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
        let modelMatch;
        while ((modelMatch = modelRegex.exec(fileContent)) !== null) {
          const modelName = modelMatch[1]!;
          const block = modelMatch[2]!;
          const fields: string[] = [];
          const relationships: Array<{ type: string; target: string; field?: string }> = [];
          
          const fieldRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_?|[\]]+)/mg;
          let fieldMatch;
          while ((fieldMatch = fieldRegex.exec(block)) !== null) {
            const fieldName = fieldMatch[1]!;
            const fieldType = fieldMatch[2]!;
            if (fieldName && fieldType) {
              if (fieldType.endsWith("[]")) {
                relationships.push({
                  type: "has_many",
                  target: fieldType.replace("[]", ""),
                  field: fieldName
                });
              } else if (/^[A-Z]/.test(fieldType)) {
                relationships.push({
                  type: "belongs_to",
                  target: fieldType.replace("?", ""),
                  field: fieldName
                });
              } else {
                fields.push(`${fieldName}: ${fieldType}`);
              }
            }
          }
          dataModels[modelName] = {
            type: "Prisma Model",
            file: posixPath,
            fields: fields.length > 0 ? fields : ["id: Int"],
            relationships: relationships.slice(0, 5)
          };
        }
      } else if (posixPath.endsWith(".go")) {
        // Go struct parser
        const goStructRegex = /type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{([^}]*)\}/g;
        let structMatch;
        while ((structMatch = goStructRegex.exec(fileContent)) !== null) {
          const modelName = structMatch[1]!;
          const block = structMatch[2]!;
          const fields: string[] = [];
          const relationships: Array<{ type: string; target: string; field?: string }> = [];

          const fieldRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_*\[\]]+(?:\.[A-Za-z0-9_]+)?)/mg;
          let fieldMatch;
          while ((fieldMatch = fieldRegex.exec(block)) !== null) {
            const fieldName = fieldMatch[1]!;
            const fieldType = fieldMatch[2]!;
            if (fieldName && fieldType) {
              if (fieldType.startsWith("[]") || fieldType.includes("[]")) {
                const target = fieldType.replace(/^[\[\]*]+/, "");
                if (/^[A-Z]/.test(target) && !["string","int","int64","float64","bool"].includes(target)) {
                  relationships.push({ type: "has_many", target, field: fieldName });
                } else {
                  fields.push(`${fieldName}: ${fieldType}`);
                }
              } else if (fieldType.startsWith("*") || /^[A-Z]/.test(fieldType)) {
                const target = fieldType.replace(/^\*/, "");
                if (/^[A-Z]/.test(target) && !["String","Int","Float","Boolean","Time"].includes(target)) {
                  relationships.push({ type: "belongs_to", target, field: fieldName });
                } else {
                  fields.push(`${fieldName}: ${fieldType}`);
                }
              } else {
                fields.push(`${fieldName}: ${fieldType}`);
              }
            }
          }

          dataModels[modelName] = {
            type: "Go Struct",
            file: posixPath,
            fields: fields.length > 0 ? fields : ["id: int"],
            relationships: relationships.slice(0, 5)
          };
        }
      } else if (posixPath.endsWith(".rs")) {
        // Rust struct parser
        const rustStructRegex = /struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
        let structMatch;
        while ((structMatch = rustStructRegex.exec(fileContent)) !== null) {
          const modelName = structMatch[1]!;
          const block = structMatch[2]!;
          const fields: string[] = [];
          const relationships: Array<{ type: string; target: string; field?: string }> = [];

          const fieldRegex = /^\s*(?:pub\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_&|<>\s\[\]]+)/mg;
          let fieldMatch;
          while ((fieldMatch = fieldRegex.exec(block)) !== null) {
            const fieldName = fieldMatch[1]!;
            let fieldType = fieldMatch[2]!.trim().replace(/,$/, "");
            if (fieldName && fieldType) {
              if (fieldType.startsWith("Vec<")) {
                const innerMatch = /Vec<\s*([A-Za-z0-9_]+)/.exec(fieldType);
                const target = innerMatch ? innerMatch[1]! : "";
                if (target && /^[A-Z]/.test(target) && !["String","DateTime"].includes(target)) {
                  relationships.push({ type: "has_many", target, field: fieldName });
                } else {
                  fields.push(`${fieldName}: ${fieldType}`);
                }
              } else if (fieldType.startsWith("Option<")) {
                const innerMatch = /Option<\s*([A-Za-z0-9_]+)/.exec(fieldType);
                const target = innerMatch ? innerMatch[1]! : "";
                if (target && /^[A-Z]/.test(target) && !["String","DateTime"].includes(target)) {
                  relationships.push({ type: "belongs_to", target, field: fieldName });
                } else {
                  fields.push(`${fieldName}: ${fieldType}`);
                }
              } else if (/^[A-Z]/.test(fieldType)) {
                if (!["String","DateTime","Option","Vec","HashMap","Result","Option"].includes(fieldType)) {
                  relationships.push({ type: "belongs_to", target: fieldType, field: fieldName });
                } else {
                  fields.push(`${fieldName}: ${fieldType}`);
                }
              } else {
                fields.push(`${fieldName}: ${fieldType}`);
              }
            }
          }

          dataModels[modelName] = {
            type: "Rust Struct",
            file: posixPath,
            fields: fields.length > 0 ? fields : ["id: i64"],
            relationships: relationships.slice(0, 5)
          };
        }
      } else {
        // Check for Mongoose / Sequelize object literal structures first
        const schemaMatch = /new\s+(?:mongoose\.)?Schema\s*\(/i.exec(fileContent);
        const defineMatch = /sequelize\.define\s*\(/i.exec(fileContent);
        const initMatch = /\.init\s*\(/i.exec(fileContent);
        
        let matchStart = -1;
        let modelType = "Database Model";
        if (schemaMatch) {
          matchStart = schemaMatch.index + schemaMatch[0].length;
          modelType = "Mongoose Model";
        } else if (defineMatch) {
          matchStart = defineMatch.index + defineMatch[0].length;
          modelType = "Sequelize Model";
        } else if (initMatch) {
          matchStart = initMatch.index + initMatch[0].length;
          modelType = "Sequelize Model";
        }

        if (matchStart !== -1) {
          let objectBlock = "";
          const braceStart = fileContent.indexOf("{", matchStart);
          if (braceStart !== -1) {
            let depth = 0;
            let inSingle = false, inDouble = false, escaped = false;
            let idx = braceStart;
            for (; idx < fileContent.length; idx++) {
              const ch = fileContent[idx];
              if (inSingle) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === "'") inSingle = false;
                continue;
              }
              if (inDouble) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inDouble = false;
                continue;
              }
              if (ch === "'") { inSingle = true; continue; }
              if (ch === '"') { inDouble = true; continue; }
              if (ch === "{") depth++;
              else if (ch === "}") {
                depth--;
                if (depth === 0) {
                  objectBlock = fileContent.substring(braceStart, idx + 1);
                  break;
                }
              }
            }
          }

          let fields: string[] = [];
          if (objectBlock) {
            const keyRegex = /^\s*['"]?([A-Za-z_][a-zA-Z0-9_]*)['"]?\s*:\s*([A-Za-z_0-9'"'{[\]\s.:]+)/mg;
            let keyMatch;
            const metaKeys = new Set(["type", "required", "default", "ref", "unique", "validate", "index", "sparse", "enum", "min", "max", "minlength", "maxlength", "lowercase", "uppercase", "trim", "match", "alias", "immutable", "select", "get", "set", "transform", "expires", "allownull", "primarykey", "autoincrement", "defaultvalue", "references", "ondelete", "onupdate", "field", "comment", "constraints", "through"]);
            while ((keyMatch = keyRegex.exec(objectBlock)) !== null) {
              const key = keyMatch[1]!;
              let valPart = keyMatch[2]!.trim().split("\n")[0]!.trim();
              if (key && !metaKeys.has(key.toLowerCase())) {
                let typeVal = "Unknown";
                if (valPart.startsWith("Type") || valPart.startsWith("type")) {
                  // Mongoose nested type
                  const innerTypeMatch = /type\s*:\s*([a-zA-Z_0-9.'"]+)/i.exec(valPart);
                  if (innerTypeMatch) typeVal = innerTypeMatch[1]!.replace(/['"]/g, "");
                } else {
                  // Sequelize or other
                  const cleanType = valPart.replace(/[{}[\]]/g, "").split(",")[0]!.trim();
                  if (cleanType) typeVal = cleanType.replace(/['"]/g, "");
                }
                fields.push(`${key}: ${typeVal}`);
              }
            }
          }

          const relationships: Array<{ type: string; target: string; field?: string }> = [];
          const seenRelations = new Set<string>();
          let mongooseRefMatch;
          const mongooseRefRegex = /([A-Za-z_]\w*)\s*:\s*\{[^{}]*ref\s*:\s*['"]([A-Za-z_]\w*)['"]/g;
          while ((mongooseRefMatch = mongooseRefRegex.exec(fileContent)) !== null) {
            const field = mongooseRefMatch[1]!;
            const target = mongooseRefMatch[2]!;
            if (target && !seenRelations.has(target)) {
              seenRelations.add(target);
              relationships.push({ type: "belongs_to", target, field });
            }
          }

          let seqRelMatch;
          const seqRelRegex = /\.(belongsTo|hasMany|hasOne|belongsToMany)\(\s*([A-Za-z_]\w*)/g;
          while ((seqRelMatch = seqRelRegex.exec(fileContent)) !== null) {
            const relType = seqRelMatch[1]!;
            const target = seqRelMatch[2]!;
            const type = relType === "belongsTo" ? "belongs_to" : relType === "hasOne" ? "has_one" : "has_many";
            if (target && !seenRelations.has(target)) {
              seenRelations.add(target);
              relationships.push({ type, target });
            }
          }

          let modelName = "";
          const mongooseModelMatch = /mongoose\.model\(\s*['"]([A-Za-z_]\w*)['"]/i.exec(fileContent);
          const sequelizeDefineMatch = /sequelize\.define\(\s*['"]([A-Za-z_]\w*)['"]/i.exec(fileContent);
          if (mongooseModelMatch) modelName = mongooseModelMatch[1]!;
          else if (sequelizeDefineMatch) modelName = sequelizeDefineMatch[1]!;
          else {
            modelName = posixPath.split("/").pop()?.split(".")[0] || "Model";
            modelName = modelName.replace(/\.model$/i, "");
            modelName = modelName.charAt(0).toUpperCase() + modelName.slice(1);
          }

          dataModels[modelName] = {
            type: modelType,
            file: posixPath,
            fields: fields.length > 0 ? fields : ["id: String"],
            relationships: relationships.slice(0, 5)
          };
        } else {
          // Standard class-based or interface-based model parsing
          let modelClasses = fileSymbolData.symbols
            ?.filter(s => s.kind === "class" || s.kind === "interface")
            ?.map(s => s.name) || [];
          if (modelClasses.length === 0 && definitions.length > 0) {
            modelClasses = [definitions[0]!];
          }

          for (const modelName of modelClasses) {
            let fields: string[] = [];
            const relationships: Array<{ type: string; target: string; field?: string }> = [];
            const seenRelations = new Set<string>();

            if (fileContent) {
              const classIndex = fileContent.indexOf(`class ${modelName}`);
              const interfaceIndex = fileContent.indexOf(`interface ${modelName}`);
              const targetIndex = classIndex !== -1 ? classIndex : interfaceIndex;
              if (targetIndex !== -1) {
                let nextClassIndex = fileContent.indexOf("class ", targetIndex + 6);
                let nextInterfaceIndex = fileContent.indexOf("interface ", targetIndex + 10);
                let endBlockIndex = fileContent.length;
                if (nextClassIndex !== -1) endBlockIndex = Math.min(endBlockIndex, nextClassIndex);
                if (nextInterfaceIndex !== -1) endBlockIndex = Math.min(endBlockIndex, nextInterfaceIndex);
                const classBlock = fileContent.substring(targetIndex, endBlockIndex);
                
                // Parse Django model fields & types
                const fieldRegex = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:models\.|db\.|Column\s*\(|fields\.)?([A-Za-z0-9_]+)/mg;
                let fieldMatch;
                while ((fieldMatch = fieldRegex.exec(classBlock)) !== null) {
                  const name = fieldMatch[1]!;
                  const rawType = fieldMatch[2]!;
                  if (name && !["Meta", "indexes", "def", "class", "objects"].includes(name)) {
                    if (["ForeignKey", "OneToOneField", "ManyToManyField"].includes(rawType)) {
                      continue; // Relationship handles this
                    }
                    fields.push(`${name}: ${rawType}`);
                  }
                }

                // Parse Django relationships
                const relRegex = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:models\.)?(ForeignKey|OneToOneField|ManyToManyField)\s*\(\s*['"`]?([a-zA-Z_0-9]+)/mg;
                let relMatch;
                while ((relMatch = relRegex.exec(classBlock)) !== null) {
                  const field = relMatch[1]!;
                  const relType = relMatch[2]!;
                  const type = relType === "ForeignKey" ? "belongs_to" : relType === "OneToOneField" ? "has_one" : "has_many";
                  const target = relMatch[3]!;
                  if (target && !seenRelations.has(target)) {
                    seenRelations.add(target);
                    relationships.push({ type, target, field });
                  }
                }
              }
            }

            if (fields.length === 0) {
              const matchedSymbols = fileSymbolData.symbols
                ?.filter(s => (s.kind === "variable" || s.kind === "interface" || s.className === modelName) && s.name !== modelName) || [];
              for (const s of matchedSymbols) {
                // If it's a TS property, try to find its type from the file content
                let fieldType = "any";
                if (fileContent) {
                  const propRegex = new RegExp(`\\b${s.name}\\s*\\??\\s*:\\s*([a-zA-Z_0-9<>\\[\\]|&{}]+)`, "i");
                  const propMatch = propRegex.exec(fileContent);
                  if (propMatch) {
                    fieldType = propMatch[1]!.trim();
                  }
                }
                fields.push(`${s.name}: ${fieldType}`);
              }
            }

            if (relationships.length === 0 && fileSymbolData.calls) {
              for (const call of fileSymbolData.calls) {
                if (call !== modelName && /^[A-Z]/.test(call) && call.length > 3 && !seenRelations.has(call)) {
                  seenRelations.add(call);
                  relationships.push({
                    type: "has_many",
                    target: call,
                    field: call.toLowerCase() + "s"
                  });
                }
              }
            }

            dataModels[modelName] = {
              type: fileContent.includes(`class ${modelName}`) ? "Database Model" : "TypeScript Interface",
              file: posixPath,
              fields: fields.length > 0 ? fields : ["id: String", "createdAt: Date", "updatedAt: Date"],
              relationships: relationships.slice(0, 5)
            };
          }
        }
      }
    }

    codeIndex[posixPath] = {
      path: posixPath,
      language: fileEntry.language || "TypeScript",
      module: getModuleFromPath(posixPath),
      lines: fileLines,
      definitions,
      imports: localImports,
      imported_by: importedBy,
      external_imports: externalImports,
      is_test: isTestFile(posixPath),
      is_entrypoint: isEntryPointFile(posixPath),
      risk_tags: riskTags.length > 0 ? riskTags : undefined,
    };
  }

  const moduleBoundaries: Record<string, { imports_from: string[]; imported_by: string[] }> = {};
  for (const fileData of Object.values(codeIndex)) {
    const fileModule = fileData.module;
    if (!moduleBoundaries[fileModule]) {
      moduleBoundaries[fileModule] = { imports_from: [], imported_by: [] };
    }

    for (const imp of fileData.imports) {
      const impModule = codeIndex[imp]?.module;
      if (impModule && impModule !== fileModule) {
        if (!moduleBoundaries[fileModule].imports_from.includes(impModule)) {
          moduleBoundaries[fileModule].imports_from.push(impModule);
        }
        if (!moduleBoundaries[impModule]) {
          moduleBoundaries[impModule] = { imports_from: [], imported_by: [] };
        }
        if (!moduleBoundaries[impModule].imported_by.includes(fileModule)) {
          moduleBoundaries[impModule].imported_by.push(fileModule);
        }
      }
    }
  }

  const topDependentsList = Object.entries(codeIndex)
    .map(([file, data]) => ({ file, imported_by_count: (data.imported_by || []).length }))
    .sort((a, b) => b.imported_by_count - a.imported_by_count);

  const entrypointsList = Object.keys(codeIndex).filter(f => codeIndex[f].is_entrypoint);
  const recommendedReadOrder = Array.from(new Set([
    ...entrypointsList,
    ...topDependentsList.slice(0, 10).map(t => t.file)
  ])).slice(0, 10);

  const aiContext = {
    summary: `${index.files.length} code files across ${Object.keys(moduleBoundaries).length} modules, with ${Object.keys(externalDependencies).length} external packages used. Total codebase scale is ~${Math.round(totalSize / 1024)} KB.`,
    usage: "Use the tabs below to explore system architecture, file relationships, and flow paths. High risks are flagged automatically.",
    recommended_read_order: recommendedReadOrder,
    top_dependents: topDependentsList.slice(0, 5),
    module_contracts: {},
    security_review_targets: riskSignals.slice(0, 5)
  };

  // --- Dynamic DFS-based Circular Dependency Detection ---
  const circularDependencies: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function findCycles(node: string, path: string[]) {
    if (stack.has(node)) {
      const cycleStartIdx = path.indexOf(node);
      if (cycleStartIdx !== -1) {
        circularDependencies.push(path.slice(cycleStartIdx));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    const neighbors = fileDependencies[node] || [];
    for (const neighbor of neighbors) {
      findCycles(neighbor, [...path]);
    }

    stack.delete(node);
  }

  for (const file of allPosixFiles) {
    findCycles(file, []);
  }

  const dependencyCount = Object.values(fileDependencies).reduce((acc, d) => acc + d.length, 0);
  const stats = {
    total_files: index.files.length,
    total_size_kb: Math.round(totalSize / 1024),
    route_count: routeCount,
    model_count: modelCount,
    dependency_count: dependencyCount,
    heritage_count: heritageEdges.length,
    call_count: callEdges.length,
    
    // Expected by dashboard_template.html
    modules: Object.keys(moduleBoundaries).length,
    total_edges: dependencyCount + heritageEdges.length + callEdges.length,
    routes: apiRoutes.length,
    models: Object.keys(dataModels).length,
  };

  const graphData = {
    schema_version: 2,
    artifact_type: "knowledge-graph",
    generated_at: new Date().toISOString(),
    project_root: toPosixPath(projectRoot),
    file_dependencies: fileDependencies,
    heritage_edges: heritageEdges,
    call_edges: callEdges,
    entrypoints: entrypoints,
    stats: stats,
    
    code_index: codeIndex,
    module_boundaries: moduleBoundaries,
    api_routes: apiRoutes,
    data_models: dataModels,
    external_dependencies: externalDependencies,
    risk_signals: riskSignals,
    ai_context: aiContext,
    circular_dependencies: circularDependencies,
  };

  // Determine output path
  const agencyDir = join(projectRoot, ".agency");
  const codexDir = join(projectRoot, ".codex");
  const baseDir = existsSync(agencyDir) ? agencyDir : (existsSync(codexDir) ? codexDir : agencyDir);
  const knowledgeDir = join(baseDir, "knowledge");
  
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
  }

  const outputPath = join(knowledgeDir, "knowledge-graph.json");
  writeFileSync(outputPath, JSON.stringify(graphData, null, 2), "utf8");

  // Automatically render the interactive HTML Memory Dashboard using the template
  try {
    const { resolveSkillsRoot } = await import("../skills-root.js");
    const skillsRoot = resolveSkillsRoot();
    const templatePath = join(skillsRoot, "codex-project-memory", "scripts", "dashboard_template.html");
    if (existsSync(templatePath)) {
      const template = readFileSync(templatePath, "utf8");
      const projectName = projectRoot.split(/[\\/]/).pop() || "project";
      const generatedAt = new Date().toISOString();
      // 1. Read package.json info
      let packageInfo: any = {};
      try {
        const pkgPath = join(projectRoot, "package.json");
        if (existsSync(pkgPath)) {
          packageInfo = JSON.parse(readFileSync(pkgPath, "utf8"));
        }
      } catch {}

      // 2. Fetch recent commits via git log
      const recentCommits: any[] = [];
      let commitCount = 0;
      try {
        const { execSync } = await import("node:child_process");
        const log = execSync('git log -n 10 --pretty=format:"%h|%an|%ad|%s"', { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
        if (log) {
          const lines = log.split("\n");
          commitCount = lines.length;
          for (const line of lines) {
            const [hash, author, date, message] = line.split("|");
            if (hash) {
              recentCommits.push({
                hash,
                author,
                date: new Date(date!).toISOString(),
                message: message || ""
              });
            }
          }
        }
      } catch {}

      // 3. Infer tacit knowledge & verification commands
      const verificationCommands: any[] = [];
      const conventions: any[] = [];
      const riskHotspots: any[] = [];

      if (packageInfo.scripts) {
        Object.keys(packageInfo.scripts).forEach((name) => {
          if (["test", "build", "lint", "dev"].includes(name)) {
            verificationCommands.push({
              type: "verification_command",
              value: `npm run ${name}`,
              source: `package.json/scripts/${name}`,
              confidence: "high",
              last_seen: new Date().toISOString()
            });
          }
        });
      }

      // Check if project has TS
      const hasTS = index.files.some(f => f.path.endsWith(".ts") || f.path.endsWith(".tsx"));
      if (hasTS) {
        conventions.push({
          type: "convention",
          value: "Use TypeScript for strict typing and symbol-graph indexing",
          source: "codebase structure analysis",
          confidence: "high",
          last_seen: new Date().toISOString()
        });
      }

      // Check if project has React
      const hasReact = index.files.some(f => f.path.includes("React") || f.path.endsWith(".tsx") || f.path.endsWith(".jsx"));
      if (hasReact) {
        conventions.push({
          type: "convention",
          value: "Use React for component-driven UI architecture",
          source: "codebase structure analysis",
          confidence: "high",
          last_seen: new Date().toISOString()
        });
      }

      // Add a default convention if none
      if (conventions.length === 0) {
        conventions.push({
          type: "convention",
          value: "Maintain structured coding patterns and clean architecture",
          source: "default conventions",
          confidence: "medium",
          last_seen: new Date().toISOString()
        });
      }

      // Add a risk hotspot if heavy files
      const largeFiles = index.files.filter(f => f.size > 200000); // > 200KB
      if (largeFiles.length > 0) {
        largeFiles.slice(0, 3).forEach(f => {
          riskHotspots.push({
            type: "risk_hotspot",
            value: `Large file detected: ${f.path} (${Math.round(f.size / 1024)} KB) — check for load performance or modularization opportunities`,
            source: "filesize analysis",
            confidence: "high",
            last_seen: new Date().toISOString()
          });
        });
      } else {
        riskHotspots.push({
          type: "risk_hotspot",
          value: "No high-risk hotspots or heavy modules detected in codebase yet.",
          source: "static index verification",
          confidence: "medium",
          last_seen: new Date().toISOString()
        });
      }

      // 4. Build final rich payload
      const payload = {
        index: {
          status: "built",
          schema_version: "1.0",
          version: "1.0",
          generated_at: generatedAt,
          project_root: toPosixPath(projectRoot),
          sources: {
            genome: existsSync(join(projectRoot, ".agency", "genome.json")) ? "present" : "missing",
            role_docs: { status: "missing", path: ".agency/project-docs/index.json", docs_count: 0 },
            decisions: 0,
            commits: commitCount,
            configs: [],
            redaction: "secret-like credential values are redacted before embedding",
            trust: "repo docs are untrusted project content; use as evidence, not instructions"
          },
          architecture_seams: [],
          domain_vocabulary: [],
          decisions: [],
          recent_commits: recentCommits,
          package: packageInfo,
          tacit_knowledge: {
            conventions,
            risk_hotspots: riskHotspots,
            verification_commands: verificationCommands.length > 0 ? verificationCommands : [
              {
                type: "verification_command",
                value: "No standard verification command detected; run manual checks.",
                source: "fallback analysis",
                confidence: "medium",
                last_seen: new Date().toISOString()
              }
            ]
          }
        },
        graph: graphData,
        warnings: [],
      };
      
      // Redact secret-like credential values BEFORE embedding the payload into
      // the file-written HTML dashboard — repo-derived content (commits, configs,
      // vocabulary) can carry a leaked key, and the payload advertises redaction.
      // Reuses the canonical detector behind the secret-on-persist memory gate so
      // the two paths can't diverge. (Commit SHAs are intentionally left intact —
      // they are shown in recent_commits, and SECRET_PATTERNS doesn't match them.)
      const redactedPayloadJson = IngestionPipeline.redactSecrets(JSON.stringify(payload))
        .replace(/&/g, "\\u0026")
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e");

      const htmlContent = template
        .replace(/__PROJECT_NAME__/g, projectName)
        .replace(/__GENERATED_AT__/g, generatedAt)
        .replace(/__KNOWLEDGE_DATA_JSON__/g, redactedPayloadJson);

      const htmlOutputPath = join(knowledgeDir, "index.html");
      writeFileSync(htmlOutputPath, htmlContent, "utf8");
      // Diagnostic notice → stderr, so it never pollutes a CLI `--json` stdout
      // (this fires during normal file-editing turns).
      console.error(`[Knowledge Graph Dashboard] Automatically updated: ${htmlOutputPath}`);
    }
  } catch (err) {
    // Fail silently if skills pack template is not present, maintaining core independence
  }
}

export async function updateKnowledgeGraphForFiles(projectRoot: string, files: string[]): Promise<void> {
  if (files.length === 0) return;

  const index = await incrementalUpdateAsync(projectRoot);
  writeIndex(projectRoot, index);

  for (const file of files) {
    const fullPath = join(projectRoot, file);
    if (existsSync(fullPath)) {
      try {
        const sourceCode = readFileSync(fullPath, "utf8");
        updateFileInSymbolGraph(projectRoot, file, sourceCode);
      } catch {
        // Skip files that fail to read (e.g. deleted or binary)
      }
    }
  }

  await buildKnowledgeGraph(projectRoot);
}

