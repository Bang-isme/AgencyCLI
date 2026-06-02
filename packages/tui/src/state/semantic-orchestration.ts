export type WorkerState =
  | "SPAWNING"
  | "ACQUIRING_CONTEXT"
  | "ANALYZING"
  | "MAPPING_DEPENDENCIES"
  | "SYNTHESIZING"
  | "VERIFYING"
  | "SELF_HEALING"
  | "CONSOLIDATING"
  | "COMPLETED"
  | "FAILED";

export interface WorkerLifecycleState {
  agentId: string;
  state: WorkerState;
  lastStateChange: number;
  task: string;
  targetFile?: string;
  elapsedMs: number;
  timeline: { timestamp: number; state: WorkerState; label: string }[];
  steps: { label: string; status: "done" | "active" | "pending" }[];
  activeStepIndex: number;
}

// 1. Semantic Translator
export class SemanticTranslator {
  public static translateTool(toolName: string, argsStr: string, target?: string): string {
    let filename = "";
    let command = "";
    if (target) {
      filename = target.split(/[\\/]/).pop() || target;
    } else if (argsStr) {
      try {
        const parsed = JSON.parse(argsStr);
        const rawPath = parsed.path || parsed.TargetFile || parsed.SearchPath || parsed.DirectoryPath || parsed.AbsolutePath;
        if (rawPath) {
          filename = rawPath.split(/[\\/]/).pop() || rawPath;
        }
        if (parsed.command || parsed.CommandLine) {
          command = parsed.command || parsed.CommandLine;
        }
      } catch { }
    }

    const cleanTool = toolName.toLowerCase();
    switch (cleanTool) {
      case "read_file":
      case "view_file":
        return filename ? `Read ${filename}` : "Read file";
      case "write_file":
      case "write_to_file":
        return filename ? `Write ${filename}` : "Write file";
      case "append_file":
        return filename ? `Append to ${filename}` : "Append to file";
      case "edit_file":
      case "replace_file_content":
      case "multi_replace_file_content":
        return filename ? `Edit ${filename}` : "Edit file";
      case "grep_search":
        return filename ? `Search ${filename}` : "Search files";
      case "find_files":
        return "Find files";
      case "execute_command":
      case "run_command": {
        const cmdName = command.split(/\s+/)[0] || command;
        return cmdName ? `Run ${cmdName}` : "Run command";
      }
      case "dispatch_subagent":
        return "Delegate to subagent";
      default:
        return `${toolName} ➔ ${filename || command || ""}`.trim();
    }
  }

  public static translatePhase(phase: string, target = ""): string {
    const p = phase.toLowerCase();
    if (p.includes("routing")) return `Routing…`;
    if (p.includes("llm") || p.includes("thought") || p.includes("thinking")) {
      return target ? `Analyzing ${target}…` : "Thinking…";
    }
    if (p.includes("staging")) {
      return target ? `Staging ${target}…` : "Staging changes…";
    }
    if (p.includes("verifying") || p.includes("validate") || p.includes("validating")) {
      return target ? `Verifying ${target}…` : "Verifying…";
    }
    if (p.includes("commit")) {
      return target ? `Committing ${target}…` : "Committing changes…";
    }
    return phase;
  }
}

// 2. Stable Transition Controller
export class StableTransitionController {
  private minDurationMs = 800;

  public canTransition(lastChangeTime: number): boolean {
    const elapsed = Date.now() - lastChangeTime;
    return elapsed >= this.minDurationMs;
  }

  public getDelayRemaining(lastChangeTime: number): number {
    const elapsed = Date.now() - lastChangeTime;
    return Math.max(0, this.minDurationMs - elapsed);
  }
}

// 3. Execution State Machine & Worker Lifecycle Tracker
export class WorkerLifecycleTracker {
  private workers = new Map<string, WorkerLifecycleState>();
  private transitionController = new StableTransitionController();
  private pendingTransitions = new Map<string, { nextState: WorkerState; label: string; timeout: NodeJS.Timeout }>();
  private listeners: ((workers: WorkerLifecycleState[]) => void)[] = [];

  public subscribe(callback: (workers: WorkerLifecycleState[]) => void): () => void {
    this.listeners.push(callback);
    callback(this.getWorkers());
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private notify() {
    const list = this.getWorkers();
    this.listeners.forEach(l => l(list));
  }

  public getWorkers(): WorkerLifecycleState[] {
    return Array.from(this.workers.values());
  }

  public registerWorker(agentId: string, task: string) {
    const now = Date.now();
    this.workers.set(agentId, {
      agentId,
      state: "SPAWNING",
      lastStateChange: now,
      task,
      elapsedMs: 0,
      timeline: [{ timestamp: now, state: "SPAWNING", label: "Spawning autonomous worker" }],
      steps: [
        { label: "Spawning specialist thread", status: "done" }
      ],
      activeStepIndex: 0
    });
    this.notify();
  }

  private capSteps(steps: { label: string; status: "done" | "active" | "pending" }[]): { label: string; status: "done" | "active" | "pending" }[] {
    if (steps.length <= 5) return steps;
    
    let olderCount = 0;
    const normalSteps = [...steps];
    if (normalSteps[0] && normalSteps[0].label.startsWith("... and ") && normalSteps[0].label.endsWith(" older steps")) {
      const match = normalSteps[0].label.match(/\.\.\. and (\d+) older steps/);
      if (match) {
        olderCount = parseInt(match[1]!, 10);
        normalSteps.shift();
      }
    }
    
    const hiddenCount = normalSteps.length - 4;
    const newOlderCount = olderCount + hiddenCount;
    const truncated = normalSteps.slice(hiddenCount);
    
    return [
      { label: `... and ${newOlderCount} older steps`, status: "done" },
      ...truncated
    ];
  }

  public transitionWorker(
    agentId: string,
    nextState: WorkerState,
    label: string,
    targetFile = "",
    step?: { label: string; status: "done" | "active" | "pending" }
  ) {
    const w = this.workers.get(agentId);
    if (!w) return;

    if (w.state === nextState && !step) return;

    // Check for pending transition cancellation
    const pending = this.pendingTransitions.get(agentId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingTransitions.delete(agentId);
    }

    const transition = () => {
      const current = this.workers.get(agentId);
      if (!current) return;
      
      const realNow = Date.now();
      current.state = nextState;
      current.lastStateChange = realNow;
      current.targetFile = targetFile || current.targetFile;
      current.timeline.push({ timestamp: realNow, state: nextState, label });
      
      // Update steps dynamically
      if (nextState === "COMPLETED") {
        current.steps.forEach(s => s.status = "done");
      } else if (nextState === "FAILED") {
        current.steps.forEach(s => {
          if (s.status === "active") s.status = "pending";
        });
        current.steps.push({ label: `Execution failed: ${label}`, status: "pending" });
      } else if (step) {
        const existing = current.steps.find(s => s.label === step.label);
        if (existing) {
          existing.status = step.status;
        } else {
          current.steps.forEach(s => {
            if (s.status === "active") s.status = "done";
          });
          current.steps.push({ label: step.label, status: step.status });
        }
      } else if (label) {
        const existing = current.steps.find(s => s.label === label);
        if (existing) {
          existing.status = "active";
        } else {
          current.steps.forEach(s => {
            if (s.status === "active") s.status = "done";
          });
          current.steps.push({ label, status: "active" });
        }
      }
      
      current.steps = this.capSteps(current.steps);
      this.workers.set(agentId, current);
      this.pendingTransitions.delete(agentId);
      this.notify();
    };

    if (this.transitionController.canTransition(w.lastStateChange)) {
      transition();
    } else {
      const delay = this.transitionController.getDelayRemaining(w.lastStateChange);
      const timeout = setTimeout(transition, delay);
      this.pendingTransitions.set(agentId, { nextState, label, timeout });
    }
  }

  public updateProgress(agentId: string, elapsedMs: number) {
    const w = this.workers.get(agentId);
    if (w) {
      w.elapsedMs = elapsedMs;
      this.notify();
    }
  }
}

// Singletons for direct access
export const globalWorkerTracker = new WorkerLifecycleTracker();
