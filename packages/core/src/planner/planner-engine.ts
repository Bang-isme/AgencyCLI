import { DagTaskNode, ExecutionDagContract, ExecutionContext } from "@agency/contracts";
import { EventBus } from "../events/event-bus.js";

export type TaskExecutor = (node: DagTaskNode, ctx: ExecutionContext) => Promise<any>;

export class PlannerEngine {
  private eventBus: EventBus;

  constructor() {
    this.eventBus = EventBus.getInstance();
  }

  /**
   * Generates a DAG contract from list of tasks and rollback configuration.
   */
  public createDag(
    tasks: Omit<DagTaskNode, "state" | "attempts">[],
    rollbackPaths: Record<string, string[]> = {}
  ): ExecutionDagContract {
    const nodes: Record<string, DagTaskNode> = {};
    for (const t of tasks) {
      nodes[t.id] = {
        ...t,
        state: "PENDING",
        attempts: 0,
      };
    }
    return {
      nodes,
      rollbackPaths,
    };
  }

  /**
   * Executes the DAG, supporting parallel task execution, retries, cancellation, and rollback.
   */
  public async execute(
    dag: ExecutionDagContract,
    context: ExecutionContext,
    executor: TaskExecutor
  ): Promise<void> {
    const completedTasksOrder: string[] = [];
    const activePromises = new Map<string, Promise<void>>();

    // Helper to check if a node has all its dependencies completed
    const areDependenciesMet = (node: DagTaskNode): boolean => {
      return node.dependencies.every((depId) => {
        const dep = dag.nodes[depId];
        return dep && dep.state === "COMPLETED";
      });
    };

    let hasFailed = false;
    let failureReason: any = null;

    // Start background heartbeat emitter (ensures progress is streamed under 4000ms threshold)
    const heartbeatInterval = setInterval(() => {
      const active = Array.from(activePromises.keys()).map(id => ({
        id,
        action: dag.nodes[id]?.action,
        attempt: dag.nodes[id]?.attempts,
      }));
      this.eventBus.publish("dag:heartbeat", {
        timestamp: Date.now(),
        activeTasks: active,
        completedCount: completedTasksOrder.length,
        totalTasks: Object.keys(dag.nodes).length,
      });
    }, 3000);

    try {
      // The main orchestration loop
      while (true) {
        if (context.cancellationToken.aborted) {
          throw new Error("DAG Execution aborted by cancellation token.");
        }

        if (hasFailed) {
          // Halt running tasks and begin rollback
          await this.handleRollback(dag, completedTasksOrder, context, executor, failureReason);
          throw new Error(`DAG Execution failed: ${failureReason?.message || failureReason}`);
        }

        // Check if all nodes are completed
        const allDone = Object.values(dag.nodes).every(
          (n) => n.state === "COMPLETED" || n.state === "SKIPPED"
        );
        if (allDone) {
          break;
        }

        // Find ready nodes
        const readyNodes = Object.values(dag.nodes).filter(
          (n) => n.state === "PENDING" && areDependenciesMet(n)
        );

        // Start executing ready nodes
        for (const node of readyNodes) {
          node.state = "RUNNING";
          const taskPromise = this.executeNodeWithRetries(node, context, executor)
            .then(() => {
              node.state = "COMPLETED";
              completedTasksOrder.push(node.id);
              activePromises.delete(node.id);
            })
            .catch((err) => {
              node.state = "FAILED";
              hasFailed = true;
              failureReason = err;
              activePromises.delete(node.id);
            });

          activePromises.set(node.id, taskPromise);
        }

        if (activePromises.size === 0 && readyNodes.length === 0) {
          // No running tasks, and no tasks are ready. Detect cycle/deadlock.
          const pendingNodes = Object.values(dag.nodes).filter((n) => n.state === "PENDING");
          if (pendingNodes.length > 0) {
            throw new Error("DAG Deadlock detected: pending tasks exist but dependencies cannot be satisfied.");
          }
          break;
        }

        // Wait for at least one active promise to finish
        await Promise.race(activePromises.values());
      }
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  private async executeNodeWithRetries(
    node: DagTaskNode,
    context: ExecutionContext,
    executor: TaskExecutor
  ): Promise<any> {
    const maxAttempts = context.governanceContext.maxAttemptsLimit || 3;

    while (node.attempts < maxAttempts) {
      if (context.cancellationToken.aborted) {
        throw new Error(`Task ${node.id} execution aborted before attempt ${node.attempts + 1}`);
      }

      node.attempts++;
      await this.eventBus.publish("dag:task:started", {
        taskId: node.id,
        attempt: node.attempts,
        action: node.action,
      });

      // Implement task-dependent timeout with proper cleanup
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Task ${node.id} timed out after ${node.timeoutMs}ms`));
        }, node.timeoutMs);
      });

      try {
        const result = await Promise.race([executor(node, context), timeoutPromise]);
        clearTimeout(timeoutHandle!);
        await this.eventBus.publish("dag:task:completed", {
          taskId: node.id,
          attempt: node.attempts,
          action: node.action,
        });
        return result;
      } catch (error: any) {
        clearTimeout(timeoutHandle!);
        await this.eventBus.publish("dag:task:attempt-failed", {
          taskId: node.id,
          attempt: node.attempts,
          error: error.message || error,
        });

        if (node.attempts >= maxAttempts) {
          await this.eventBus.publish("dag:task:failed", {
            taskId: node.id,
            error: error.message || error,
          });
          throw error;
        }

        // Exponential backoff between retries (e.g., 200ms * 2^attempt)
        const delay = Math.min(200 * Math.pow(2, node.attempts - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async handleRollback(
    dag: ExecutionDagContract,
    completedTasksOrder: string[],
    context: ExecutionContext,
    executor: TaskExecutor,
    originalError: any
  ): Promise<void> {
    await this.eventBus.publish("dag:rollback:initiated", {
      reason: originalError?.message || originalError,
      completedTasks: completedTasksOrder,
    });

    // Rollback completed tasks in reverse order of completion
    const reverseCompleted = [...completedTasksOrder].reverse();

    for (const taskId of reverseCompleted) {
      const rollbackTasks = dag.rollbackPaths[taskId];
      if (!rollbackTasks || rollbackTasks.length === 0) {
        continue;
      }

      await this.eventBus.publish("dag:task:rollback:started", { taskId });

      for (const rollbackAction of rollbackTasks) {
        const rollbackNode: DagTaskNode = {
          id: `rollback-${taskId}-${rollbackAction}`,
          dependencies: [],
          action: rollbackAction,
          params: { originalTaskId: taskId },
          state: "RUNNING",
          timeoutMs: 30000, // standard 30s timeout for rollback
          attempts: 0,
        };

        try {
          await executor(rollbackNode, context);
          await this.eventBus.publish("dag:task:rollback:step:completed", {
            taskId,
            action: rollbackAction,
          });
        } catch (err: any) {
          console.error(`Failed to execute rollback action ${rollbackAction} for task ${taskId}:`, err);
          await this.eventBus.publish("dag:task:rollback:step:failed", {
            taskId,
            action: rollbackAction,
            error: err.message || err,
          });
          // Continue best-effort rollback of other tasks
        }
      }

      await this.eventBus.publish("dag:task:rollback:completed", { taskId });
    }
  }
}
