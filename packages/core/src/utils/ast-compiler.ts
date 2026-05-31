import ts from "typescript";
import { PatchOperation } from "@agency/contracts";

/**
 * Replaces the body of a class method matched by class name and method name.
 */
export function replaceMethodBody(
  sourceCode: string,
  className: string,
  methodName: string,
  newBody: string
): string {
  const sourceFile = ts.createSourceFile("file.ts", sourceCode, ts.ScriptTarget.Latest, true);
  let targetNode: ts.MethodDeclaration | undefined;

  function findNode(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name && node.name.text === className) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === methodName
        ) {
          targetNode = member;
          return;
        }
      }
    }
    ts.forEachChild(node, findNode);
  }

  findNode(sourceFile);

  if (!targetNode || !targetNode.body) {
    throw new Error(`Method ${methodName} in class ${className} not found or has no body.`);
  }

  const start = targetNode.body.getStart(sourceFile);
  const end = targetNode.body.getEnd();

  let bodyReplacement = newBody.trim();
  if (!bodyReplacement.startsWith("{")) {
    bodyReplacement = `{\n  ${bodyReplacement.split("\n").join("\n  ")}\n}`;
  }

  return sourceCode.substring(0, start) + bodyReplacement + sourceCode.substring(end);
}

/**
 * Replaces the body of a standalone function declaration.
 */
export function replaceFunctionBody(
  sourceCode: string,
  functionName: string,
  newBody: string
): string {
  const sourceFile = ts.createSourceFile("file.ts", sourceCode, ts.ScriptTarget.Latest, true);
  let targetNode: ts.FunctionDeclaration | undefined;

  function findNode(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) {
      targetNode = node;
      return;
    }
    ts.forEachChild(node, findNode);
  }

  findNode(sourceFile);

  if (!targetNode || !targetNode.body) {
    throw new Error(`Function ${functionName} not found or has no body.`);
  }

  const start = targetNode.body.getStart(sourceFile);
  const end = targetNode.body.getEnd();

  let bodyReplacement = newBody.trim();
  if (!bodyReplacement.startsWith("{")) {
    bodyReplacement = `{\n  ${bodyReplacement.split("\n").join("\n  ")}\n}`;
  }

  return sourceCode.substring(0, start) + bodyReplacement + sourceCode.substring(end);
}

/**
 * Appends a function block to the end of the file.
 */
export function insertFunction(sourceCode: string, functionCode: string): string {
  return sourceCode.trimEnd() + "\n\n" + functionCode.trim() + "\n";
}

/**
 * Renames all identifier matches of a symbol.
 */
export function renameSymbol(sourceCode: string, oldName: string, newName: string): string {
  const sourceFile = ts.createSourceFile("file.ts", sourceCode, ts.ScriptTarget.Latest, true);
  const replacements: { start: number; end: number; text: string }[] = [];

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === oldName) {
      replacements.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        text: newName,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Sort replacements in descending order of start position
  replacements.sort((a, b) => b.start - a.start);

  let output = sourceCode;
  for (const rep of replacements) {
    output = output.substring(0, rep.start) + rep.text + output.substring(rep.end);
  }
  return output;
}

/**
 * Modifies import declarations for a given module specifier.
 */
export function modifyImport(
  sourceCode: string,
  moduleSpecifier: string,
  namedImportsToAdd: string[],
  namedImportsToRemove: string[] = []
): string {
  const sourceFile = ts.createSourceFile("file.ts", sourceCode, ts.ScriptTarget.Latest, true);
  let importNode: ts.ImportDeclaration | undefined;

  function findImport(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier.getText(sourceFile).replace(/['"`]/g, "");
      if (specifier === moduleSpecifier) {
        importNode = node;
        return;
      }
    }
    ts.forEachChild(node, findImport);
  }

  findImport(sourceFile);

  if (importNode) {
    const importClause = importNode.importClause;
    if (importClause && importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      const existingImports = importClause.namedBindings.elements.map((el) => el.name.text);
      const updatedImports = new Set(existingImports);

      for (const add of namedImportsToAdd) {
        updatedImports.add(add);
      }
      for (const remove of namedImportsToRemove) {
        updatedImports.delete(remove);
      }

      if (updatedImports.size === 0) {
        const start = importNode.getFullStart();
        const end = importNode.getEnd();
        return sourceCode.substring(0, start) + sourceCode.substring(end);
      }

      const newBindingsText = `{ ${Array.from(updatedImports).join(", ")} }`;
      const start = importClause.namedBindings.getStart(sourceFile);
      const end = importClause.namedBindings.getEnd();
      return sourceCode.substring(0, start) + newBindingsText + sourceCode.substring(end);
    }
    throw new Error(`Import declaration for ${moduleSpecifier} is not a named import.`);
  } else {
    if (namedImportsToAdd.length === 0) {
      return sourceCode;
    }
    const newImportLine = `import { ${namedImportsToAdd.join(", ")} } from "${moduleSpecifier}";\n`;
    return newImportLine + sourceCode;
  }
}

/**
 * Deletes a function, class, or variable node by name.
 */
export function deleteNode(sourceCode: string, targetName: string): string {
  const sourceFile = ts.createSourceFile("file.ts", sourceCode, ts.ScriptTarget.Latest, true);
  let targetNode: ts.Node | undefined;

  function findNode(node: ts.Node) {
    if (
      (ts.isFunctionDeclaration(node) && node.name && node.name.text === targetName) ||
      (ts.isClassDeclaration(node) && node.name && node.name.text === targetName) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === targetName
        ))
    ) {
      targetNode = node;
      return;
    }
    ts.forEachChild(node, findNode);
  }

  findNode(sourceFile);

  if (!targetNode) {
    throw new Error(`Node named ${targetName} to delete was not found.`);
  }

  const start = targetNode.getFullStart();
  const end = targetNode.getEnd();
  return sourceCode.substring(0, start) + sourceCode.substring(end);
}

/**
 * Applies a structured PatchOperation using TS Compiler AST positions.
 */
export function applyPatch(sourceCode: string, patch: PatchOperation): string {
  switch (patch.type) {
    case "InsertFunction":
      return insertFunction(sourceCode, patch.replacementContent || "");
    case "ReplaceMethodBody": {
      const className = patch.meta?.className;
      if (!className) {
        // Fallback to replace standalone function if className not provided
        return replaceFunctionBody(sourceCode, patch.targetName, patch.replacementContent || "");
      }
      return replaceMethodBody(
        sourceCode,
        className,
        patch.targetName,
        patch.replacementContent || ""
      );
    }
    case "RenameSymbol": {
      const newName = patch.replacementContent;
      if (!newName) {
        throw new Error("replacementContent (new name) must be specified for RenameSymbol patch.");
      }
      return renameSymbol(sourceCode, patch.targetName, newName);
    }
    case "ModifyImport": {
      const moduleSpecifier = patch.targetName;
      const namedImportsToAdd = patch.meta?.namedImportsToAdd || [];
      const namedImportsToRemove = patch.meta?.namedImportsToRemove || [];
      return modifyImport(sourceCode, moduleSpecifier, namedImportsToAdd, namedImportsToRemove);
    }
    case "DeleteNode":
      return deleteNode(sourceCode, patch.targetName);
    default:
      // Allow custom extensions or fallback
      if (patch.type === ("ReplaceFunctionBody" as any)) {
        return replaceFunctionBody(sourceCode, patch.targetName, patch.replacementContent || "");
      }
      throw new Error(`Unsupported patch type: ${patch.type}`);
  }
}
