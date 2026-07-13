import { EventBus } from "../events/event-bus.js";
import { type CircuitBreakerState } from "./circuit-breaker.js";
import { runShellCommand } from "../terminal/sandbox.js";
import { existsSync } from "node:fs";

export interface LoopMitigationResult {
  action: "continue" | "abort";
  feedback?: string;
}

/**
 * Handles loop mitigation by injecting a self-reflection prompt (Tầng 1)
 * or pausing execution and publishing a loop:paused event (Tầng 2) for the user to steer or rollback.
 */
export async function handleLoopMitigation(
  state: CircuitBreakerState,
  turnHistory: { role: string; content: string }[],
  context: {
    agentId?: string;
    conversationId?: string;
    projectRoot: string;
    /**
     * Only interactive hosts that are actively subscribed to loop:paused and can
     * publish loop:resume should set this. Without a consumer, waiting here makes
     * the turn look alive while it is actually blocked.
     */
    waitForResume?: boolean;
  }
): Promise<LoopMitigationResult> {
  // 1. Tầng 1: Self-Reflection Prompt Injection
  if (state.consecutiveFailures >= 3 && !state.hasInjectedReflection) {
    state.hasInjectedReflection = true;
    turnHistory.push({
      role: "system",
      content: `[SYSTEM WARNING] You have failed to fix the error in the last 3 attempts. Stop your current approach. Analyze why it is failing, brainstorm 2 alternative architectures, and switch to a different strategy.`
    });
    void EventBus.getInstance().publish("loop:reflection", {
      agentId: context.agentId,
      conversationId: context.conversationId,
      message: "Self-reflection prompt injected due to 3 consecutive failures."
    });
  }

  // 2. Tầng 2: Live Grill Pause (at 5 consecutive failures)
  if (state.consecutiveFailures >= 5) {
    const agentId = context.agentId || "default-agent";
    const conversationId = context.conversationId || "default-conv";

    // Publish loop:paused event on the global EventBus
    void EventBus.getInstance().publish("loop:paused", {
      agentId,
      conversationId,
      consecutiveFailures: state.consecutiveFailures,
      lastModifiedFiles: state.lastModifiedFiles
    });

    if (!context.waitForResume && process.env.AGENCY_LIVE_GRILL_WAIT !== "1") {
      return {
        action: "abort",
        feedback: "Live Grill pause requested but no interactive resume handler is attached. Aborting instead of blocking the turn."
      };
    }

    // Wait for loop:resume
    return new Promise<LoopMitigationResult>((resolve) => {
      const isHeadless = !process.stdout.isTTY || process.env.CI || process.env.NON_INTERACTIVE;
      
      const timeoutId = setTimeout(() => {
        EventBus.getInstance().unsubscribe("loop:resume", onResume);
        resolve({
          action: "abort",
          feedback: "Live Grill paused loop timed out (or headless execution mode). Automatically aborting to prevent hanging."
        });
      }, isHeadless ? 5000 : 300000); // 5s for headless/CI, 5 min for interactive

      async function onResume(event: any) {
        let payload = event.payload;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            // Ignore parse errors
          }
        }

        // Match conversationId or agentId
        if (payload.conversationId !== conversationId && payload.agentId !== agentId) {
          return;
        }

        clearTimeout(timeoutId);
        EventBus.getInstance().unsubscribe("loop:resume", onResume);

        if (payload.action === "rollback") {
          const filesToRollback = state.lastModifiedFiles.filter(f => existsSync(f));
          if (filesToRollback.length > 0) {
            try {
              const filePaths = filesToRollback.map(f => `"${f}"`).join(" ");
              await runShellCommand(context.projectRoot, `git checkout -- ${filePaths}`);
            } catch (err) {
              console.error("Failed to perform safe rollback:", err);
            }
          }
          resolve({
            action: "abort",
            feedback: "Rollback performed on session-modified files. Execution aborted."
          });
        } else if (payload.action === "abort") {
          resolve({
            action: "abort",
            feedback: payload.feedback || "Execution aborted by user."
          });
        } else {
          // continue / resume with steering instructions
          resolve({
            action: "continue",
            feedback: payload.feedback
          });
        }
      }

      EventBus.getInstance().subscribe("loop:resume", onResume);
    });
  }

  return { action: "continue" };
}
