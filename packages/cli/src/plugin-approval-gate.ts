import { appendAudit, requiresApproval } from "@agency/core/approval";
import { EventBus } from "@agency/core";

/**
 * Approval-gate policy for plugin-tool execution, injected into the
 * `@agency/skills-bridge` `runTool` via its `onBeforeRun` hook.
 *
 * This policy used to live INSIDE `runTool`, which forced the skills-bridge
 * (pure script-runner mechanism) to import `@agency/core`'s approval engine +
 * event bus — a back-edge that made `core ↔ skills-bridge` a package-level
 * import cycle. Moving the policy here (the CLI = the orchestration layer that
 * owns approval) keeps the bridge dependency-free while preserving the exact
 * behaviour: a write-capable tool run without explicit approval warns on stderr
 * and emits a `system:warning`; every run is audited when a project root is
 * known (always recorded `approved: true`, matching the prior logic).
 */
export function pluginApprovalGate(ctx: {
  toolName: string;
  writesArtifacts: boolean;
  yes: boolean;
  projectRoot?: string;
}): void {
  if (requiresApproval(ctx.toolName, ctx.writesArtifacts) && !ctx.yes) {
    const warnMsg = `Security Warning: Tool ${ctx.toolName} executed without explicit approval.`;
    process.stderr.write(`${warnMsg}\n`);
    void EventBus.getInstance().publish("system:warning", { message: warnMsg });
  }
  if (ctx.projectRoot) {
    appendAudit(ctx.projectRoot, {
      action: "tool",
      tool: ctx.toolName,
      approved: true,
    });
  }
}
