import { compileGoalPillars, formatGoalAnchorPrompt } from "@agency/heuristics";
import type { RouteResult } from "../router/model-router.js";
import type { ChatMessage } from "./orchestrator.js";
import { registry } from "../skill/tool-harness.js";

function formatToolDocs(): string {
  const tools = registry.listTools();
  return tools.map((tool, idx) => {
    const lines = [`${idx + 1}. \`${tool.name}\`: ${tool.description}`];
    
    // Check if dynamic MCP tool schema exists
    const mcpSchema = (tool as any).mcpSchema;
    if (mcpSchema && mcpSchema.properties) {
      lines.push("   Arguments:");
      const requiredList = mcpSchema.required || [];
      for (const [key, val] of Object.entries(mcpSchema.properties)) {
        const prop = val as any;
        const isOptional = !requiredList.includes(key);
        const typeStr = prop.type || "string";
        const descStr = prop.description ? ` - ${prop.description}` : "";
        lines.push(`   - \`<${key}>\`${isOptional ? " (optional)" : ""}: Parameter of type ${typeStr}.${descStr}`);
      }
    } else {
      const shape = (tool.schema as any).shape;
      if (shape && Object.keys(shape).length > 0) {
        lines.push("   Arguments:");
        for (const [key, val] of Object.entries(shape)) {
          let isOptional = false;
          let typeStr = "string";
          
          let currentType = val as any;
          if (currentType._def && currentType._def.typeName === "ZodOptional") {
            isOptional = true;
            currentType = currentType._def.innerType;
          }
          if (currentType._def && currentType._def.typeName === "ZodUnion") {
            typeStr = "string | number";
          } else if (currentType._def && currentType._def.typeName === "ZodBoolean") {
            typeStr = "boolean";
          }
          
          lines.push(`   - \`<${key}>\`${isOptional ? " (optional)" : ""}: Parameter of type ${typeStr}.`);
        }
      }
    }
    return lines.join("\n");
  }).join("\n\n");
}

export function buildSystemPrompt(
  route: RouteResult,
  userPrompt: string,
  contextPack: string,
  projectRoot: string,
  history?: ChatMessage[],
  systemInstructionOverride?: string,
  historicalMemories?: string
): string {
  const firstUserMsg = history?.find((m) => m.role === "user")?.content || userPrompt;
  const pillars = compileGoalPillars(firstUserMsg);
  const anchorBlock = formatGoalAnchorPrompt(pillars);

  const agentPart = route.suggested_agent
    ? ` Suggested agent: ${route.suggested_agent}.`
    : "";
  const baseSystemPrompt = [
    anchorBlock,
    "",
    `You are Agency CLI — a CodexAI skills harness operating in the workspace at ${projectRoot}.`,
    `User intent: ${route.intent}. Workflow: ${route.workflow}.${agentPart}`,
    "You have full read access to the workspace. Use the provided context pack (which includes a project file tree and selected file contents) to answer the user's questions, analyze code, or write file changes.",
    "Be structured and concise; avoid generic filler and repeated tool dumps.",
    "",
    "### WORKING PROGRESSION & SOLUTION ARCHITECTURE PROTOCOL",
    "To ensure every workflow stays on track to the right goal and leverages its past working timeline without losing context:",
    "1. TIMELINE ALIGNMENT: Utilize the `### SYSTEM HISTORICAL MEMORIES` to reconstruct the exact chronological timeline of past steps. Never repeat actions or edits that have already succeeded or been ruled out.",
    "2. THE 5-APPROACHES RULE: When proposing planning, architectural, or task resolution strategies, you MUST outline exactly 5 distinct, structured approaches or next steps.",
    "3. PRIORITIZATION GRADIENT: Sort these 5 approaches by recommendation level (from highest recommended to fallback alternatives). For each approach, detail: its pros/cons, success criteria, and a concrete next command/action to keep the workflow on-track.",
    "",
    "",
    "### SYSTEM TOOL CALLS PROTOCOL",
    "You have access to powerful system tools. If you need to perform actions (read/write/edit files, run terminal commands, or recursively spawn specialist subagents), you must output a tool call using the following XML format:",
    "<tool_call name=\"tool_name\">",
    "  <param_name>param_value</param_name>",
    "</tool_call>",
    "",
    "CRITICAL TOOL PROTOCOL RULES:",
    "1. IMMEDIATE TOOL INVOCATION: If the user asks you to read/edit a file, run a command, or spawn/dispatch a specialist subagent, you MUST output the XML tool call block immediately in your response! Never respond with plain text like 'I will spawn a subagent' or 'I will analyze' without including the corresponding `<tool_call>` block in the exact same turn. Doing so will freeze the system without executing the action. You must trigger the tool call immediately.",
    "2. SPANNING SUBAGENTS: If the user requests to spawn a subagent, delegate to a specialist, or perform deep code analysis/restructuring, immediately call `dispatch_subagent` with the correct specialist `<agentId>` and a clear, descriptive `<task>`. The TUI will render a dedicated real-time worker progress panel displaying the subagent's execution phase, elapsed time, and findings. Trigger this tool call immediately so the user can see the progress of the worker.",
    "3. Once you output a tool call, execution will pause, the tool will run, and you will receive the tool's result in the next turn as a User message so you can continue your task.",
    "",
    "AVAILABLE TOOLS:",
    formatToolDocs(),
    "",
    contextPack,
    "",
    historicalMemories ? `### SYSTEM HISTORICAL MEMORIES\n${historicalMemories}\n` : "",
    "",
    `User question: ${userPrompt.trim()}`,
  ].join("\n");

  if (systemInstructionOverride) {
    return `${systemInstructionOverride}\n\n${baseSystemPrompt}`;
  }
  return baseSystemPrompt;
}
