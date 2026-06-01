import { promises as fs } from "node:fs";
import { DeterministicExecutionTrace, ReplayEngine } from "@agency/telemetry";

export async function loadTraceFile(filePath: string): Promise<DeterministicExecutionTrace> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

export interface ReplayRegressionResult {
  success: boolean;
  turnsReplayed: number;
  unconsumedOutputs: number;
  /**
   * Recorded LLM responses (§2.5) the executor never reproduced. 0 for pre-§2.5
   * traces (no completions recorded) — those behave exactly as before.
   */
  unconsumedLlmResponses: number;
  error?: string;
}

export async function runRegressionReplay(
  trace: DeterministicExecutionTrace,
  simulatedExecutor: (engine: ReplayEngine) => Promise<void>
): Promise<ReplayRegressionResult> {
  const engine = new ReplayEngine(trace);

  try {
    // Run the executor under test, passing the ReplayEngine
    await simulatedExecutor(engine);

    // Verify all tool outputs in the trace were consumed
    const unconsumed = engine.getUnconsumedCount();
    if (unconsumed > 0) {
      return {
        success: false,
        turnsReplayed: engine.getCurrentTurnIndex(),
        unconsumedOutputs: unconsumed,
        unconsumedLlmResponses: engine.getUnconsumedLlmCount(),
        error: `Replay completed but ${unconsumed} recorded tool outputs were not consumed. Behavioral deviation detected.`,
      };
    }

    // §2.5 — and that every recorded LLM completion was reproduced in order.
    const unconsumedLlm = engine.getUnconsumedLlmCount();
    if (unconsumedLlm > 0) {
      return {
        success: false,
        turnsReplayed: engine.getCurrentTurnIndex(),
        unconsumedOutputs: 0,
        unconsumedLlmResponses: unconsumedLlm,
        error: `Replay completed but ${unconsumedLlm} recorded LLM responses were not reproduced. Behavioral deviation detected.`,
      };
    }

    return {
      success: true,
      turnsReplayed: engine.getCurrentTurnIndex(),
      unconsumedOutputs: 0,
      unconsumedLlmResponses: 0,
    };
  } catch (err: any) {
    return {
      success: false,
      turnsReplayed: engine.getCurrentTurnIndex(),
      unconsumedOutputs: engine.getUnconsumedCount(),
      unconsumedLlmResponses: engine.getUnconsumedLlmCount(),
      error: err.message || String(err),
    };
  }
}
