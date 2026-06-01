import { compileGoalPillars, formatGoalAnchorPrompt } from "@agency/heuristics";
import type { RouteResult } from "../router/model-router.js";
import type { ChatMessage } from "./orchestrator.js";
import { registry } from "../skill/tool-harness.js";
import { getRuntimeFlags } from "../runtime/flags.js";

/** Resolve a built-in (zod) arg's optional flag + display type. */
function describeZodArg(val: unknown): { isOptional: boolean; typeStr: string } {
  let isOptional = false;
  let typeStr = "string";
  let currentType = val as any;
  if (currentType?._def && currentType._def.typeName === "ZodOptional") {
    isOptional = true;
    currentType = currentType._def.innerType;
  }
  if (currentType?._def && currentType._def.typeName === "ZodUnion") {
    typeStr = "string | number";
  } else if (currentType?._def && currentType._def.typeName === "ZodBoolean") {
    typeStr = "boolean";
  }
  return { isOptional, typeStr };
}

// §8.11-D: the system prompt is re-sent every turn, and the built-in tool docs
// repeat a `- <arg>: Parameter of type string.` line for every arg of every tool
// (~1109 tokens of tool docs). `compact` collapses each built-in tool's args to a
// single `Args: \`a\`, \`b?\`` line (names + `?` for optional + a type suffix only
// when it isn't the default string) — the schema the model actually needs, far
// fewer tokens. MCP tools (which carry per-arg descriptions worth keeping) stay
// verbose in both modes. Off → the verbose form, byte-identical to legacy.
function formatToolDocs(compact: boolean, fileMemoryOn: boolean): string {
  // The `remember` tool is only advertised when curated markdown memory is on, so
  // the legacy prompt is byte-identical (the tool stays registered/executable, it
  // just isn't offered to the model). All other tools are always advertised.
  const tools = registry.listTools().filter((t) => fileMemoryOn || t.name !== "remember");
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
        if (compact) {
          const parts = Object.entries(shape).map(([key, val]) => {
            const { isOptional, typeStr } = describeZodArg(val);
            return `\`${key}${isOptional ? "?" : ""}\`${typeStr !== "string" ? `: ${typeStr}` : ""}`;
          });
          lines.push(`   Args: ${parts.join(", ")}`);
        } else {
          lines.push("   Arguments:");
          for (const [key, val] of Object.entries(shape)) {
            const { isOptional, typeStr } = describeZodArg(val);
            lines.push(`   - \`<${key}>\`${isOptional ? " (optional)" : ""}: Parameter of type ${typeStr}.`);
          }
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

  // --- Prompt segments, classified by how often they change across the turns of
  // a single session. Splitting them out lets us assemble two orderings from the
  // same strings (no prose is duplicated): the legacy order (byte-identical), or
  // the cache-optimised order that puts the STATIC prefix first.
  //
  //  static       — identical every turn (identity + protocols + tool docs)
  //  sessionAnchor — stable within a session (goal pillars from the first user msg)
  //  variableTail  — changes every turn (route intent, context, memories, question)

  const sessionAnchor = [anchorBlock, ""];
  const identity = [
    `You are Agency CLI — a CodexAI skills harness operating in the workspace at ${projectRoot}.`,
  ];
  const intent = [
    `User intent: ${route.intent}. Workflow: ${route.workflow}.${agentPart}`,
  ];
  const guidance = [
    "You have full read access to the workspace. Use the provided context pack (which includes a project file tree and selected file contents) to answer the user's questions, analyze code, or write file changes.",
    "Be structured and concise; avoid generic filler and repeated tool dumps.",
    "",
  ];
  const flags = getRuntimeFlags();
  // §8.11-C: the rigid "MUST outline exactly 5 approaches every turn" rule wastes
  // output tokens (pricier than input) and reads formulaic on simple tasks. When
  // on, scale it to "a few" by complexity; legacy keeps the exact-5 text verbatim.
  const approachesRule = flags.softApproaches
    ? [
        "2. SOLUTION OPTIONS: When proposing planning, architectural, or task-resolution strategies, outline a few (typically 2–3) distinct, well-differentiated approaches, scaled to the task's complexity — a simple task may warrant a single clear recommendation rather than padded alternatives.",
        "3. PRIORITIZATION GRADIENT: Sort the proposed approaches by recommendation level (highest recommended first). For each, give its key trade-offs, success criteria, and a concrete next command/action to keep the workflow on-track.",
      ]
    : [
        "2. THE 5-APPROACHES RULE: When proposing planning, architectural, or task resolution strategies, you MUST outline exactly 5 distinct, structured approaches or next steps.",
        "3. PRIORITIZATION GRADIENT: Sort these 5 approaches by recommendation level (from highest recommended to fallback alternatives). For each approach, detail: its pros/cons, success criteria, and a concrete next command/action to keep the workflow on-track.",
      ];
  const protocol = [
    "### WORKING PROGRESSION & SOLUTION ARCHITECTURE PROTOCOL",
    "To ensure every workflow stays on track to the right goal and leverages its past working timeline without losing context:",
    "1. TIMELINE ALIGNMENT: Utilize the `### SYSTEM HISTORICAL MEMORIES` to reconstruct the exact chronological timeline of past steps. Never repeat actions or edits that have already succeeded or been ruled out.",
    ...approachesRule,
    ...(flags.fileMemory
      ? [
          "",
          "### PERSISTENT MEMORY PROTOCOL",
          "You keep a durable, curated memory across sessions. Recalled entries appear in `### SYSTEM HISTORICAL MEMORIES`: treat every `user`/`feedback` memory as a STANDING instruction. When you learn something worth keeping for a FUTURE session — a user preference or instruction, a project decision, or a non-obvious finding (a root cause, a deliberate trade-off, a constraint not derivable from the code) — save it with the `remember` tool (a one-line `description`, the `content`, and a `type`: user|feedback|project|reference). Do NOT save what the code or git history already records, or what only matters to the current turn.",
        ]
      : []),
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
    formatToolDocs(flags.compactToolDocs, flags.fileMemory),
    "",
  ];
  const variableTail = [
    contextPack,
    "",
    historicalMemories ? `### SYSTEM HISTORICAL MEMORIES\n${historicalMemories}\n` : "",
    "",
    `User question: ${userPrompt.trim()}`,
  ];

  // Same segments, two orderings (reorder only — identical content + element
  // count, so total length is preserved):
  //  legacy  — anchor, identity, intent, guidance, protocol, tail
  //  cache   — identity, guidance, protocol (STATIC prefix), anchor, intent, tail
  const ordered = flags.promptCachePrefix
    ? [...identity, ...guidance, ...protocol, ...sessionAnchor, ...intent, ...variableTail]
    : [...sessionAnchor, ...identity, ...intent, ...guidance, ...protocol, ...variableTail];
  const baseSystemPrompt = ordered.join("\n");

  if (systemInstructionOverride) {
    return `${systemInstructionOverride}\n\n${baseSystemPrompt}`;
  }
  return baseSystemPrompt;
}
