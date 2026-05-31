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
        error: `Replay completed but ${unconsumed} recorded tool outputs were not consumed. Behavioral deviation detected.`,
      };
    }

    return {
      success: true,
      turnsReplayed: engine.getCurrentTurnIndex(),
      unconsumedOutputs: 0,
    };
  } catch (err: any) {
    return {
      success: false,
      turnsReplayed: engine.getCurrentTurnIndex(),
      unconsumedOutputs: engine.getUnconsumedCount(),
      error: err.message || String(err),
    };
  }
}
