import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

export interface SymbolInfo {
  name: string;
  kind: "class" | "method" | "function" | "variable" | "interface";
  className?: string;
  start: number;
  end: number;
}

/** Semantic findings extracted via regex/AST scanning */
export interface SemanticFindings {
  /** Detected API endpoint count (route handlers, decorators, etc.) */
  endpoints: number;
  /** Detected middleware/guard checks */
  middlewareChecks: number;
  /** Summary labels for TUI display (e.g. "18 endpoints", "4 middleware checks") */
  labels: string[];
}

export interface FileSymbolData {
  filePath: string;
  hash: string;
  symbols: SymbolInfo[];
  imports: { name: string; module: string }[];
  /** Semantic findings: endpoints, middleware, etc. */
  semanticFindings?: SemanticFindings;
  heritage?: { className: string; parentName: string; kind: "extends" | "implements" }[];
  calls?: string[];
  exports?: string[];
}

export interface SymbolGraph {
  version: 1;
  files: Record<string, FileSymbolData>;
}

/**
 * Extracts symbols and import dependencies from TypeScript/JavaScript source code.
 */
export function extractSymbolsAndImports(sourceCode: string, filePath: string): FileSymbolData {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isJsOrTs = ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext);

  if (!isJsOrTs) {
    const symbols: SymbolInfo[] = [];
    const imports: { name: string; module: string }[] = [];
    
    // Generic symbol pattern: class/struct/interface/fn/def/func
    const symbolRegex = /\b(class|struct|interface|enum|fn|func|def|function)\s+([A-Za-z_][\w$]*)/g;
    let match;
    while ((match = symbolRegex.exec(sourceCode)) !== null) {
      if (match[2]) {
        const keyword = match[1];
        const kind = keyword === "class" || keyword === "struct" ? "class" :
                     keyword === "interface" ? "interface" :
                     "function";
        symbols.push({
          name: match[2],
          kind: kind as any,
          start: match.index,
          end: match.index + match[0].length
        });
      }
    }

    // Generic imports patterns
    const importRegexes = [
      /\b(?:import|using|require)\s+['"`]?([A-Za-z_][\w./-]*)/g,
      /\bfrom\s+([A-Za-z_][\w./-]*)\s+import\b/g,
      /\buse\s+([A-Za-z_][\w:]*)/g,
      /\b(?:src|href)\s*=\s*['"`]([^'"`]+)/g
    ];

    const seenImports = new Set<string>();
    for (const rx of importRegexes) {
      let impMatch;
      while ((impMatch = rx.exec(sourceCode)) !== null) {
        if (impMatch[1]) {
          const mod = impMatch[1].trim();
          if (mod && !seenImports.has(mod)) {
            seenImports.add(mod);
            imports.push({ name: mod.split("/").pop() || mod, module: mod });
          }
        }
      }
    }

    const hash = createHash("sha256").update(sourceCode).digest("hex").slice(0, 16);
    const semanticFindings = extractSemanticFindings(sourceCode, filePath);

    return {
      filePath,
      hash,
      symbols: symbols.slice(0, 200),
      imports: imports.slice(0, 200),
      semanticFindings,
    };
  }

  const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);
  const symbols: SymbolInfo[] = [];
  const imports: { name: string; module: string }[] = [];
  const heritage: { className: string; parentName: string; kind: "extends" | "implements" }[] = [];
  const calls: string[] = [];
  const exportsList: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"`]/g, "");
      const importClause = node.importClause;
      if (importClause) {
        if (importClause.name) {
          imports.push({ name: importClause.name.text, module: moduleSpecifier });
        }
        if (importClause.namedBindings) {
          if (ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
              imports.push({ name: element.name.text, module: moduleSpecifier });
            }
          } else if (ts.isNamespaceImport(importClause.namedBindings)) {
            imports.push({ name: importClause.namedBindings.name.text, module: moduleSpecifier });
          }
        }
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      symbols.push({
        name: className,
        kind: "class",
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });

      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        exportsList.push(className);
      }

      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
          for (const typeNode of clause.types) {
            const parentName = typeNode.expression.getText(sourceFile);
            heritage.push({ className, parentName, kind });
          }
        }
      }

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          symbols.push({
            name: member.name.text,
            kind: "method",
            className: className,
            start: member.getStart(sourceFile),
            end: member.getEnd(),
          });
        } else if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          symbols.push({
            name: member.name.text,
            kind: "variable",
            className: className,
            start: member.getStart(sourceFile),
            end: member.getEnd(),
          });
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const funcName = node.name.text;
      symbols.push({
        name: funcName,
        kind: "function",
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        exportsList.push(funcName);
      }
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      const interfaceName = node.name.text;
      symbols.push({
        name: interfaceName,
        kind: "interface",
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          symbols.push({
            name: member.name.text,
            kind: "variable",
            className: interfaceName,
            start: member.getStart(sourceFile),
            end: member.getEnd(),
          });
        }
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.push({
            name: decl.name.text,
            kind: "variable",
            start: decl.getStart(sourceFile),
            end: decl.getEnd(),
          });
        }
      }
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        calls.push(expr.text);
      } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
        calls.push(expr.name.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportsList.push(element.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const hash = createHash("sha256").update(sourceCode).digest("hex").slice(0, 16);
  const semanticFindings = extractSemanticFindings(sourceCode, filePath);

  return {
    filePath,
    hash,
    symbols,
    imports,
    semanticFindings,
    heritage: heritage.length > 0 ? heritage : undefined,
    calls: calls.length > 0 ? Array.from(new Set(calls)) : undefined,
    exports: exportsList.length > 0 ? Array.from(new Set(exportsList)) : undefined,
  };
}

/**
 * Regex-based semantic scanning: detects API endpoints and middleware signatures.
 * Covers common patterns: Express/Koa/Fastify route handlers, decorators (@Get, @Post, etc.),
 * Next.js route exports, and middleware/guard patterns.
 */
export function extractSemanticFindings(sourceCode: string, filePath: string): SemanticFindings {
  let endpoints = 0;
  let middlewareChecks = 0;
  const labels: string[] = [];

  // Detect route/endpoint patterns
  const endpointPatterns = [
    // Express-style: app.get/post/put/delete/patch/all/route
    /\b(?:app|router|server)\s*\.\s*(?:get|post|put|delete|patch|all|route|options|head)\s*\(/g,
    // Decorator-based: @Get(), @Post(), @Put(), @Delete(), @Patch(), @Controller()
    /@(?:Get|Post|Put|Delete|Patch|Options|Head|All|Controller|RequestMapping)\s*\(/g,
    // Next.js / API route exports: export async function GET/POST/PUT/DELETE
    /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/g,
    // Fastify-style: fastify.get/post/route
    /\b(?:fastify|instance)\s*\.\s*(?:get|post|put|delete|patch|route)\s*\(/g,
    // Hono/tRPC-style: .get(, .post(, .mutation(, .query(
    /\.\s*(?:mutation|query)\s*\(/g,
    // FastAPI decorators: @app.get(), @router.post() etc.
    /@(?:app|router|api)\.(?:get|post|put|delete|patch|options|head)\s*\(/g,
    // Flask decorators: @app.route()
    /@(?:app|router|api)\.route\s*\(/g,
  ];

  for (const pattern of endpointPatterns) {
    const matches = sourceCode.match(pattern);
    if (matches) endpoints += matches.length;
  }

  // Detect middleware / guard / interceptor patterns
  const middlewarePatterns = [
    // Express-style: app.use(, router.use(
    /\b(?:app|router)\s*\.\s*use\s*\(/g,
    // Decorator-based guards/interceptors: @UseGuards, @UseInterceptors, @Middleware
    /@(?:UseGuards|UseInterceptors|Middleware|UsePipes)\s*\(/g,
    // Middleware function signatures: (req, res, next) or (ctx, next)
    /function\s+\w*[Mm]iddleware\s*\(/g,
    // Auth checks: isAuthenticated, requireAuth, checkPermission, verifyToken
    /\b(?:isAuthenticated|requireAuth|checkPermission|verifyToken|authorize|authenticate)\s*[(\s]/g,
  ];

  for (const pattern of middlewarePatterns) {
    const matches = sourceCode.match(pattern);
    if (matches) middlewareChecks += matches.length;
  }

  // Build summary labels for TUI panel display
  const baseName = filePath.split(/[/\\]/).pop() ?? filePath;
  if (endpoints > 0) {
    labels.push(`${baseName} • ${endpoints} endpoint${endpoints > 1 ? "s" : ""}`);
  }
  if (middlewareChecks > 0) {
    labels.push(`${baseName} • ${middlewareChecks} middleware check${middlewareChecks > 1 ? "s" : ""}`);
  }

  return { endpoints, middlewareChecks, labels };
}

/**
 * Persists the symbol graph JSON file.
 */
export function saveSymbolGraph(projectRoot: string, graph: SymbolGraph): void {
  const agencyDir = join(projectRoot, ".agency");
  const codexDir = join(projectRoot, ".codex");
  const dir = existsSync(agencyDir) ? agencyDir : (existsSync(codexDir) ? codexDir : agencyDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, "symbol-graph.json");
  writeFileSync(filePath, JSON.stringify(graph, null, 2), "utf8");
}

/**
 * Loads the symbol graph or returns a fresh one if missing/corrupted.
 */
export function loadSymbolGraph(projectRoot: string): SymbolGraph {
  const agencyPath = join(projectRoot, ".agency", "symbol-graph.json");
  const codexPath = join(projectRoot, ".codex", "symbol-graph.json");
  const filePath = existsSync(agencyPath) ? agencyPath : (existsSync(codexPath) ? codexPath : agencyPath);
  if (!existsSync(filePath)) {
    return { version: 1, files: {} };
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as SymbolGraph;
  } catch {
    return { version: 1, files: {} };
  }
}

/**
 * Performs a fast incremental update to the symbol graph for a modified file.
 */
export function updateFileInSymbolGraph(
  projectRoot: string,
  filePath: string,
  sourceCode: string
): SymbolGraph {
  const graph = loadSymbolGraph(projectRoot);
  const hash = createHash("sha256").update(sourceCode).digest("hex").slice(0, 16);
  const existing = graph.files[filePath];
  if (existing && existing.hash === hash) {
    return graph;
  }
  const fileData = extractSymbolsAndImports(sourceCode, filePath);
  graph.files[filePath] = fileData;
  saveSymbolGraph(projectRoot, graph);
  return graph;
}
