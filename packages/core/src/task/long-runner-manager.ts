import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../events/event-bus.js";

export interface RunnerState {
  id: string;
  taskId: string;
  status: "running" | "stalled" | "completed" | "failed";
  lastHeartbeat: number;
  pid?: number;
}

export class LongRunnerManager {
  private runnersDir: string;
  private runnersPath: string;
  private eventBus: EventBus;
  private heartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();
  private signalRegistered = false;

  constructor(projectRoot: string) {
    this.runnersDir = join(projectRoot, ".agency", "tasks");
    this.runnersPath = join(this.runnersDir, "runners.jsonl");
    this.eventBus = EventBus.getInstance();
  }

  /**
   * Loads all runner states from the runners.jsonl file.
   */
  public listRunners(): RunnerState[] {
    if (!existsSync(this.runnersPath)) {
      return [];
    }
    try {
      const content = readFileSync(this.runnersPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      const map = new Map<string, RunnerState>();
      for (const line of lines) {
        const state = JSON.parse(line) as RunnerState;
        map.set(state.id, state);
      }
      return Array.from(map.values());
    } catch {
      return [];
    }
  }

  /**
   * Persists a runner state by appending it to the JSONL log.
   */
  public saveRunnerState(state: RunnerState): void {
    if (!existsSync(this.runnersDir)) {
      mkdirSync(this.runnersDir, { recursive: true });
    }
    appendFileSync(this.runnersPath, JSON.stringify(state) + "\n", "utf8");
  }

  /**
   * Registers a new runner, persisting its initial state and starting its heartbeat emitter.
   */
  public registerRunner(id: string, taskId: string, pid?: number): void {
    const state: RunnerState = {
      id,
      taskId,
      status: "running",
      lastHeartbeat: Date.now(),
      pid,
    };
    this.saveRunnerState(state);

    // Set up heartbeat timer every 3000ms
    if (this.heartbeats.has(id)) {
      clearInterval(this.heartbeats.get(id)!);
    }
    const interval = setInterval(() => {
      this.updateHeartbeat(id);
    }, 3000);
    this.heartbeats.set(id, interval);
  }

  /**
   * Emits a heartbeat for an active runner.
   */
  public updateHeartbeat(id: string): void {
    const runners = this.listRunners();
    const current = runners.find((r) => r.id === id);
    if (current && current.status === "running") {
      const updated: RunnerState = {
        ...current,
        lastHeartbeat: Date.now(),
      };
      this.saveRunnerState(updated);
      void this.eventBus.publish("runner:heartbeat", { runnerId: id, timestamp: updated.lastHeartbeat });
    }
  }

  /**
   * Marks a runner as successfully completed.
   */
  public markCompleted(id: string): void {
    this.stopHeartbeat(id);
    const runners = this.listRunners();
    const current = runners.find((r) => r.id === id);
    if (current) {
      const updated: RunnerState = {
        ...current,
        status: "completed",
        lastHeartbeat: Date.now(),
      };
      this.saveRunnerState(updated);
    }
  }

  /**
   * Marks a runner as failed.
   */
  public markFailed(id: string): void {
    this.stopHeartbeat(id);
    const runners = this.listRunners();
    const current = runners.find((r) => r.id === id);
    if (current) {
      const updated: RunnerState = {
        ...current,
        status: "failed",
        lastHeartbeat: Date.now(),
      };
      this.saveRunnerState(updated);
    }
  }

  private stopHeartbeat(id: string): void {
    const interval = this.heartbeats.get(id);
    if (interval) {
      clearInterval(interval);
      this.heartbeats.delete(id);
    }
  }

  public stopAll(): void {
    for (const id of Array.from(this.heartbeats.keys())) {
      this.stopHeartbeat(id);
    }
  }

  /**
   * Scans active runners and triggers a failover/rollback callback if no heartbeat for > 15s.
   */
  public async checkStalledRunners(
    onStalled: (runner: RunnerState) => Promise<void>
  ): Promise<void> {
    const runners = this.listRunners();
    const now = Date.now();
    for (const runner of runners) {
      if (runner.status === "running") {
        if (now - runner.lastHeartbeat > 15000) {
          this.stopHeartbeat(runner.id);
          const updated: RunnerState = {
            ...runner,
            status: "stalled",
            lastHeartbeat: now,
          };
          this.saveRunnerState(updated);

          await this.eventBus.publish("runner:stalled", {
            runnerId: runner.id,
            taskId: runner.taskId,
          });

          try {
            await onStalled(updated);
          } catch (err: any) {
            console.error(`Failover handler failed for runner ${runner.id}:`, err);
          }
        }
      }
    }
  }

  /**
   * Setup SIGINT / SIGTERM intercept hooks for graceful state preservation and sandbox shutdown.
   */
  public setupGracefulShutdown(cleanupFn: () => Promise<void>): void {
    if (this.signalRegistered) return;
    this.signalRegistered = true;

    const handleShutdown = async (signal: string) => {
      this.stopAll();
      const runners = this.listRunners();
      for (const runner of runners) {
        if (runner.status === "running") {
          this.saveRunnerState({
            ...runner,
            status: "failed",
            lastHeartbeat: Date.now(),
          });
        }
      }

      await this.eventBus.publish("runner:shutdown", { signal, timestamp: Date.now() });

      try {
        await cleanupFn();
      } catch (err) {
        console.error("Cleanup failed during graceful shutdown:", err);
      }

      if (process.env.AGENCY_TUI !== "true") {
        process.exit(signal === "SIGINT" ? 130 : 128);
      }
    };

    process.once("SIGINT", () => handleShutdown("SIGINT"));
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  }
}
