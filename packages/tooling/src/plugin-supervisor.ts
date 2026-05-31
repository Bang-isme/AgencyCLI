import { ChildProcess } from "node:child_process";

export interface PluginProcessDetails {
  pluginId: string;
  process: ChildProcess;
  lastHeartbeat: number;
  timeoutMs: number;
  timer: NodeJS.Timeout;
}

export class PluginSupervisor {
  private activePlugins = new Map<string, PluginProcessDetails>();

  /**
   * Registers a plugin's child process under watchdog supervision.
   */
  public registerProcess(
    pluginId: string,
    proc: ChildProcess,
    timeoutMs = 30000
  ): void {
    if (this.activePlugins.has(pluginId)) {
      this.terminate(pluginId);
    }

    const timer = setInterval(() => {
      this.checkWatchdog(pluginId);
    }, Math.min(timeoutMs / 2, 5000));

    this.activePlugins.set(pluginId, {
      pluginId,
      process: proc,
      lastHeartbeat: Date.now(),
      timeoutMs,
      timer,
    });

    // Cleanup automatically on process exit
    proc.on("exit", () => {
      this.clearSupervisorData(pluginId);
    });
  }

  /**
   * Registers a heartbeat ping from the plugin.
   */
  public heartbeat(pluginId: string): void {
    const details = this.activePlugins.get(pluginId);
    if (details) {
      details.lastHeartbeat = Date.now();
    }
  }

  /**
   * Terminates a hanging or crashing plugin process.
   */
  public terminate(pluginId: string): Promise<void> {
    const details = this.activePlugins.get(pluginId);
    if (!details) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const proc = details.process;
      this.clearSupervisorData(pluginId);

      if (proc.killed) {
        resolve();
        return;
      }

      proc.once("close", () => resolve());
      
      // Attempt gentle termination
      proc.kill("SIGTERM");

      // Hard kill fallback after 2 seconds
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
          resolve();
        }
      }, 2000);
    });
  }

  /**
   * Checks if a specific plugin is healthy.
   */
  public isHealthy(pluginId: string): boolean {
    const details = this.activePlugins.get(pluginId);
    if (!details) return false;

    const timeSinceHeartbeat = Date.now() - details.lastHeartbeat;
    return timeSinceHeartbeat < details.timeoutMs && !details.process.killed;
  }

  private checkWatchdog(pluginId: string): void {
    const details = this.activePlugins.get(pluginId);
    if (!details) return;

    const timeSinceLastHeartbeat = Date.now() - details.lastHeartbeat;
    if (timeSinceLastHeartbeat > details.timeoutMs) {
      // Watchdog timeout triggered - terminate plugin process
      this.terminate(pluginId);
    }
  }

  private clearSupervisorData(pluginId: string): void {
    const details = this.activePlugins.get(pluginId);
    if (details) {
      clearInterval(details.timer);
      this.activePlugins.delete(pluginId);
    }
  }
}
