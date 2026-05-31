import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { spawnSync, type ChildProcess } from "node:child_process";
import pidusage from "pidusage";
import { buildSuggestedCommands } from "../chat/orchestrator.js";
import { runChatTurnWithStream } from "../chat/stream.js";
import { runVerifyLoop } from "../task/verify-loop.js";
import { parseFileEditSuggestions } from "../utils/file-parser.js";
import { buildIndex, writeIndex } from "../index/workspace-indexer.js";
import { routeUserPrompt } from "../router/model-router.js";
import { resolveSkillsRoot } from "../skills-root.js";
import { EventBus } from "../events/event-bus.js";
import { buildAcceptanceCommands } from "../utils/package-manager.js";
import {
  AGENT_DISCIPLINES,
  coerceAgentId,
  subagentPromptPath,
  loadCustomAgents,
} from "./profiles.js";
import { type AgentId, MANIFEST_AGENTS, isAgentId } from "./types.js";
import { capabilityRegistry } from "./agent-registry.js";
import {
  createIsolatedWorkspace,
  mergeWorkspaceChanges,
  cleanIsolatedWorkspace,
  detectWorkspaceChanges,
  type MergeResult,
} from "./workspace-isolation.js";
import { LockManager, StagingEngine } from "@agency/workspace";
import { getRuntimeFlags } from "../runtime/flags.js";
import { globalCostGovernor } from "../utils/governance-instance.js";

const lockManager = new LockManager();
const stagingEngine = new StagingEngine();

export class WorkerRegistry {
  private static instance: WorkerRegistry;
  private activeWorkers = new Set<ChildProcess>();
  private monitorInterval: NodeJS.Timeout | null = null;
  private readonly maxMemoryBytes = 512 * 1024 * 1024; // 512MB RAM cap

  private constructor() {
    this.startMonitoring();
  }

  public static getInstance(): WorkerRegistry {
    if (!WorkerRegistry.instance) {
      WorkerRegistry.instance = new WorkerRegistry();
    }
    return WorkerRegistry.instance;
  }

  public register(proc: any): void {
    if (!proc || typeof proc.on !== "function") return;
    this.activeWorkers.add(proc);
    proc.on("exit", () => {
      this.activeWorkers.delete(proc);
      if (proc.pid) {
        pidusage.clear();
      }
    });
  }

  private startMonitoring(): void {
    if (this.monitorInterval) return;
    this.monitorInterval = setInterval(async () => {
      for (const proc of this.activeWorkers) {
        if (!proc.pid || proc.killed) {
          this.activeWorkers.delete(proc);
          continue;
        }
        try {
          const stats = await pidusage(proc.pid);
          if (stats.memory > this.maxMemoryBytes) {
            void EventBus.getInstance().publish("system:warning", {
              message: `Worker process ${proc.pid} exceeded 512MB cap (${(stats.memory / 1024 / 1024).toFixed(1)}MB). Terminating process tree.`
            });
            this.killProcessTree(proc);
          }
        } catch {
          // process exited
        }
      }
    }, 1000);
    this.monitorInterval.unref();
  }

  public killProcessTree(proc: ChildProcess): void {
    if (!proc.pid || proc.killed) return;
    const pid = proc.pid;
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" });
      } catch {
        // ignore
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.activeWorkers.delete(proc);
    pidusage.clear();
  }

  public cleanupAll(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    for (const proc of this.activeWorkers) {
      this.killProcessTree(proc);
    }
    this.activeWorkers.clear();
  }
}


export class LockAcquisitionError extends Error {
  override readonly name = "LockAcquisitionError";
  constructor(message: string) {
    super(message);
  }
}

export class WorkspaceValidationError extends Error {
  override readonly name = "WorkspaceValidationError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when an agent dispatch would exceed the delegation safety ceilings
 * (recursion depth, hop count) or would form a delegation cycle (A→B→A).
 * Closes the "unbounded recursive/cyclic delegation" CRITICAL failure mode.
 */
export class DelegationLimitError extends Error {
  override readonly name = "DelegationLimitError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when an agent dispatch exceeds its wall-clock execution budget. The
 * dispatch returns a failed result rather than hanging the orchestrator
 * indefinitely. Closes the "hung worker runs forever" HIGH failure mode.
 */
export class DispatchTimeoutError extends Error {
  override readonly name = "DispatchTimeoutError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Races a promise against a wall-clock deadline. When `ms` is 0 the deadline is
 * disabled and the promise is awaited directly. On expiry the returned promise
 * rejects with {@link DispatchTimeoutError}; the underlying work is already
 * iteration-bounded (maxLoops) so it cannot run away even if it keeps going.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms || ms <= 0) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DispatchTimeoutError(`Agent "${label}" exceeded execution budget of ${ms}ms`)),
      ms
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DELEGATION_DEPTH_ENV = "AGENCY_NESTING_DEPTH";
const DELEGATION_CHAIN_ENV = "AGENCY_DELEGATION_CHAIN";

interface DelegationContext {
  depth: number;
  chain: string[];
}

/** Reads this process's position in the delegation tree from the environment. */
function readDelegationContext(env: NodeJS.ProcessEnv = process.env): DelegationContext {
  const depth = parseInt(env[DELEGATION_DEPTH_ENV] ?? "0", 10);
  const rawChain = env[DELEGATION_CHAIN_ENV] ?? "";
  return {
    depth: Number.isFinite(depth) && depth > 0 ? depth : 0,
    chain: rawChain ? rawChain.split(",").filter(Boolean) : [],
  };
}

/**
 * Enforces delegation ceilings before spawning a child agent. Throws
 * {@link DelegationLimitError} on violation. No-op when guards are disabled.
 * Returns the child's delegation context to propagate via env.
 */
export function enforceDelegationLimits(
  req: AgentDispatchRequest,
  env: NodeJS.ProcessEnv = process.env
): DelegationContext {
  const flags = getRuntimeFlags(env);
  const current = readDelegationContext(env);
  const childDepth = current.depth + 1;
  const childChain = [...current.chain, req.agentId];

  if (flags.delegationGuards) {
    if (childDepth > flags.maxDepth) {
      throw new DelegationLimitError(
        `Delegation depth ${childDepth} exceeds max_depth=${flags.maxDepth} (chain: ${childChain.join(" → ")}). Aborting to prevent runaway recursion.`
      );
    }
    if (childChain.length > flags.maxHops) {
      throw new DelegationLimitError(
        `Delegation hops ${childChain.length} exceeds max_hops=${flags.maxHops}. Aborting long delegation chain.`
      );
    }
    if (current.chain.includes(req.agentId)) {
      throw new DelegationLimitError(
        `Circular delegation detected: "${req.agentId}" already in chain ${current.chain.join(" → ")}. Aborting cycle.`
      );
    }
  }

  return { depth: childDepth, chain: childChain };
}

export { MANIFEST_AGENTS, isAgentId, type AgentId, type MergeResult };

export interface AgentDispatchRequest {
  agentId: AgentId;
  task: string;
  projectRoot: string;
  contextFiles?: string[];
}

export interface AgentDispatchPayload {
  agentId: AgentId;
  task: string;
  coordinatorRoute: Awaited<ReturnType<typeof routeUserPrompt>>;
  subagentRoute: Record<string, unknown> | null;
  suggestedCommands: string[];
  disciplines: string[];
  agentPromptPath: string | null;
  subagentStdout: string;
  subagentStderr: string;
  llmResponse?: string;
  filesWritten?: string[];
}

export interface AgentDispatchResult {
  agentId: AgentId;
  exitCode: number;
  stdout: string;
  stderr: string;
  isolatedEnv: Record<string, string>;
  payload?: AgentDispatchPayload;
}

export interface DispatchAgentOptions {
  skillsRoot?: string;
  providerId?: string;
  noLlm?: boolean;
  originalProjectRoot?: string;
  reasoningBudgetMultiplier?: number;
  maxLoops?: number;
  /** Wall-clock deadline for this dispatch in ms (0/undefined → use runtime flag). */
  executionBudgetMs?: number;
  /** Max concurrent agents for parallel dispatch (undefined → use runtime flag). */
  maxParallelAgents?: number;
}

export function agentsDir(projectRoot: string): string {
  return join(projectRoot, ".agency", "agents");
}

export function buildIsolatedEnv(req: AgentDispatchRequest): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) {
    env.PATH = process.env.PATH;
  }
  env.AGENCY_AGENT_ID = req.agentId;
  env.AGENCY_TASK = req.task;
  env.AGENCY_PROJECT_ROOT = req.projectRoot;
  if (req.contextFiles?.length) {
    env.AGENCY_CONTEXT_FILES = req.contextFiles.join(",");
  }
  // Propagate this dispatch's position in the delegation tree so the child
  // process can enforce depth/hop/cycle ceilings against the full chain.
  const child = readDelegationContext(process.env);
  env[DELEGATION_DEPTH_ENV] = String(child.depth + 1);
  env[DELEGATION_CHAIN_ENV] = [...child.chain, req.agentId].join(",");
  return env;
}

function logDispatch(
  projectRoot: string,
  request: AgentDispatchRequest,
  result: AgentDispatchResult
): void {
  const dir = agentsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const timestamp = Date.now();
  const record = {
    timestamp: new Date().toISOString(),
    request,
    result,
  };
  writeFileSync(
    join(dir, `dispatch-${timestamp}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
}

function buildDispatchPrompt(req: AgentDispatchRequest): string {
  return `[${req.agentId}] ${req.task}`.trim();
}

async function runSubagentRouter(
  skillsRoot: string,
  req: AgentDispatchRequest
): Promise<{ exitCode: number; stdout: string; stderr: string; route: Record<string, unknown> | null }> {
  const script = join(skillsRoot, ".system/scripts/prompt_router.py");
  if (!existsSync(script)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `prompt_router not found: ${script}`,
      route: null,
    };
  }

  const prompt = buildDispatchPrompt(req);
  const procPromise = execa(
    "python",
    [script, "--prompt", prompt, "--format", "json"],
    {
      cwd: req.projectRoot,
      env: buildIsolatedEnv(req),
      reject: false,
      detached: true,
    }
  );
  WorkerRegistry.getInstance().register(procPromise);
  const proc = await procPromise;

  let route: Record<string, unknown> | null = null;
  if (proc.exitCode === 0 && proc.stdout.trim()) {
    try {
      route = JSON.parse(proc.stdout) as Record<string, unknown>;
    } catch {
      route = null;
    }
  }

  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout,
    stderr: proc.stderr,
    route,
  };
}

export async function dispatchAgent(
  req: AgentDispatchRequest,
  opts: DispatchAgentOptions = {}
): Promise<AgentDispatchResult> {
  const eventBus = EventBus.getInstance();
  const startTime = Date.now();

  // Capability-driven routing (flag-gated, audit §5(C)). Resolve the operative
  // agent *before* the delegation/cycle checks so the whole dispatch — chain,
  // events, prompt, health — uses one consistent id. With the flag off this is
  // a no-op and req keeps the legacy hardcoded role routing.
  if (getRuntimeFlags().capabilityRouting) {
    const routing = capabilityRegistry.resolveAgentForTask({
      requested: req.agentId,
      task: req.task,
      projectRoot: req.projectRoot,
    });
    if (routing.rerouted) {
      await eventBus.publish("subagent:routed", {
        requested: req.agentId,
        routedTo: routing.agentId,
        matched: routing.matched,
        reason: routing.reason,
        timestamp: Date.now(),
      }, { agentId: routing.agentId as string });
      req = { ...req, agentId: routing.agentId };
    }
  }

  // Delegation safety: reject runaway recursion / cycles before doing any work
  // or spawning processes. Throws DelegationLimitError when guards trip.
  enforceDelegationLimits(req);

  // Health/utilization: mark this agent busy now that the dispatch is committed.
  // recordOutcome + markDone run once the exit code is known (below).
  capabilityRegistry.markInFlight(req.agentId, req.task);

  await eventBus.publish("subagent:started", {
    agentId: req.agentId,
    task: req.task,
    status: "running",
    timestamp: startTime,
  }, { agentId: req.agentId as string });

  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();
  const isolatedEnv = buildIsolatedEnv(req);
  const prompt = buildDispatchPrompt(req);

  await eventBus.publish("subagent:progress", {
    agentId: req.agentId,
    phase: "Routing Prompt",
    elapsedMs: Date.now() - startTime,
  });

  const coordinatorRoute = await routeUserPrompt(
    skillsRoot,
    prompt,
    req.projectRoot
  );

  const sub = await runSubagentRouter(skillsRoot, req);
  const effectiveAgent = coerceAgentId(
    (sub.route?.suggested_agent as string | null) ??
      coordinatorRoute.suggested_agent,
    req.agentId,
    req.projectRoot
  );

  const suggestedCommands = buildSuggestedCommands(
    {
      ...coordinatorRoute,
      suggested_agent: effectiveAgent,
    },
    req.projectRoot,
    req.task
  );

  let subagentStdout = sub.stdout;
  let subagentStderr = sub.stderr;
  let llmResponse: string | undefined;
  let filesWritten: string[] | undefined;
  // Attribution: estimated USD cost of this subagent's LLM turn, attached to the
  // terminal lifecycle event (audit §5B / roadmap §1B). Pure estimate — does not
  // charge the live budget.
  let subagentCostUsd: number | undefined;

  let hasError = false;
  // Real LLM task completion
  try {
    const contextRefs = req.contextFiles?.length
      ? "\n\nContext files:\n" + req.contextFiles.map((f) => `@${f}`).join("\n")
      : "";

    const promptPath = subagentPromptPath(skillsRoot, req.agentId, req.projectRoot);
    let systemInstructionOverride: string | undefined = undefined;
    if (promptPath && existsSync(promptPath)) {
      const { readFileSync } = await import("node:fs");
      systemInstructionOverride = readFileSync(promptPath, "utf8");
    }

    await eventBus.publish("subagent:progress", {
      agentId: req.agentId,
      phase: "Executing LLM Turn",
      elapsedMs: Date.now() - startTime,
    });

    let subagentText = "";
    let subagentThought = "";
    // Streaming/thinking deltas arrive once per token. Re-publishing the full
    // accumulated buffer on every token is O(n²), and once a payload crosses the
    // EventBus 8KB ceiling it forces a (previously synchronous) large-payload
    // file spill *per token* — which starves the Node event loop and freezes the
    // TUI's spinner and "elapsed" counter while a subagent streams (only a
    // keypress would briefly unstick it). The TUI never reads these text/thought
    // payloads (it only needs the phase + a live elapsed), so emit a throttled,
    // constant-size heartbeat instead of the unbounded buffer. The first delta
    // fires immediately (lastEmit=0); the rest are throttled.
    const STREAM_PROGRESS_THROTTLE_MS = 200;
    let lastStreamProgressMs = 0;
    let lastThoughtProgressMs = 0;
    const deadlineMs = opts.executionBudgetMs ?? getRuntimeFlags().executionBudgetMs;
    const chatTurnResult = await withDeadline(runChatTurnWithStream(
      {
        prompt: req.task + contextRefs,
        projectRoot: req.projectRoot,
        skillsRoot,
        providerId: opts.providerId as any,
        noLlm: opts.noLlm,
        systemInstructionOverride,
        agentId: req.agentId,
        reasoningBudgetMultiplier: opts.reasoningBudgetMultiplier,
        maxLoops: opts.maxLoops ?? 15,
      },
      {
        onRoute: () => {},
        onDelta: (delta) => {
          subagentText += delta;
          const ts = Date.now();
          if (ts - lastStreamProgressMs >= STREAM_PROGRESS_THROTTLE_MS) {
            lastStreamProgressMs = ts;
            void eventBus.publish("subagent:progress", {
              agentId: req.agentId,
              phase: "Streaming response",
              chars: subagentText.length,
              elapsedMs: ts - startTime,
            });
          }
        },
        onThought: (thoughtDelta) => {
          subagentThought += thoughtDelta;
          const ts = Date.now();
          if (ts - lastThoughtProgressMs >= STREAM_PROGRESS_THROTTLE_MS) {
            lastThoughtProgressMs = ts;
            void eventBus.publish("subagent:progress", {
              agentId: req.agentId,
              phase: "Thinking...",
              chars: subagentThought.length,
              elapsedMs: ts - startTime,
            });
          }
        },
      }
    ), deadlineMs, req.agentId);

    if (chatTurnResult && !chatTurnResult.routeOnly) {
      llmResponse = chatTurnResult.assistantText;
      subagentStdout = chatTurnResult.assistantText;

      // Estimate the turn cost for event attribution (consistent with the cost
      // governor's own per-token estimate; never charges the budget here).
      const usage = (chatTurnResult as { completionMetadata?: { promptTokens?: number; completionTokens?: number } }).completionMetadata;
      if (usage) {
        subagentCostUsd = globalCostGovernor.estimateCost(
          usage.promptTokens ?? 0,
          usage.completionTokens ?? 0,
          String(opts.providerId ?? "")
        );
      }

      let suggestions = parseFileEditSuggestions(chatTurnResult.assistantText, req.projectRoot);
      if (suggestions.length > 0) {
        filesWritten = [];
        const acquiredLocks: string[] = [];
        // Acceptance criteria: build (always) + lint/test when the flags ask and
        // the project defines those scripts. Widens "build pass" toward "task
        // actually correct". Legacy (flags off) → just [[build]], unchanged.
        const acceptanceCommands = buildAcceptanceCommands(req.projectRoot, {
          lint: getRuntimeFlags().verifyLint,
          test: getRuntimeFlags().verifyTests,
        });
        let pendingTxId: string | null = null;
        let lastErrors = "";

        // Outer verify→self-correct loop. OFF (legacy) → maxRounds 1 = single
        // attempt → verify → commit-or-throw, byte-identical to before. ON →
        // re-run the LLM with the verification failures fed back, up to N rounds
        // (with no-progress detection), so a bad first edit gets self-corrected
        // instead of just failing.
        const verifyMaxRounds = getRuntimeFlags().verifyLoop
          ? Math.max(1, getRuntimeFlags().verifyMaxRounds)
          : 1;

        try {
          const loop = await runVerifyLoop(
            async (ctx) => {
              if (ctx.round > 1) {
                // Self-correction round: re-attempt with the prior failure in context.
                await eventBus.publish("subagent:progress", {
                  agentId: req.agentId,
                  phase: `Self-healing (round ${ctx.round})`,
                  elapsedMs: Date.now() - startTime,
                });
                const fixPrompt =
                  req.task +
                  contextRefs +
                  `\n\n[Your previous edit failed verification. Fix these errors and output the corrected edits]\n` +
                  (ctx.previousFailures ?? "");
                const fix = await withDeadline(
                  runChatTurnWithStream(
                    {
                      prompt: fixPrompt,
                      projectRoot: req.projectRoot,
                      skillsRoot,
                      providerId: opts.providerId as any,
                      noLlm: opts.noLlm,
                      systemInstructionOverride,
                      agentId: req.agentId,
                      reasoningBudgetMultiplier: opts.reasoningBudgetMultiplier,
                      maxLoops: opts.maxLoops ?? 15,
                    },
                    { onRoute: () => {}, onDelta: () => {}, onThought: () => {} }
                  ),
                  deadlineMs,
                  req.agentId
                );
                suggestions = parseFileEditSuggestions(fix?.assistantText ?? "", req.projectRoot);
              }

              // Fresh transaction each round; drop the previous failed one.
              if (pendingTxId) {
                stagingEngine.discardTransaction(pendingTxId);
                pendingTxId = null;
              }
              const txId = `tx-${Date.now()}-r${ctx.round}`;
              stagingEngine.startTransaction(txId);
              pendingTxId = txId;

              for (const sug of suggestions) {
                const resolvedPath = resolve(req.projectRoot, sug.filePath);
                const resolvedRoot = resolve(req.projectRoot);
                if (resolvedPath.startsWith(resolvedRoot)) {
                  if (!acquiredLocks.includes(sug.filePath)) {
                    const hasLock = await lockManager.acquireLock(sug.filePath, req.agentId, 15000);
                    if (!hasLock) {
                      throw new LockAcquisitionError(`Lock acquisition timed out for file: ${sug.filePath}`);
                    }
                    acquiredLocks.push(sug.filePath);
                  }

                  let originalContent: string | null = null;
                  if (existsSync(resolvedPath)) {
                    const { readFileSync } = await import("node:fs");
                    originalContent = readFileSync(resolvedPath, "utf8");
                  }

                  await eventBus.publish("subagent:progress", {
                    agentId: req.agentId,
                    phase: `Staging: ${sug.filePath}`,
                    elapsedMs: Date.now() - startTime,
                  });
                  stagingEngine.stageFile(txId, sug.filePath, originalContent, sug.content);
                }
              }
            },
            async () => {
              await eventBus.publish("subagent:progress", {
                agentId: req.agentId,
                phase: "Verifying changes (compiling & checking build)...",
                elapsedMs: Date.now() - startTime,
              });
              if (!pendingTxId) return { passed: false, failures: "no edits produced" };
              const verifyResult = await stagingEngine.verifyTransaction(
                pendingTxId,
                req.projectRoot,
                acceptanceCommands
              );
              lastErrors = verifyResult.errors.join("\n");
              return { passed: verifyResult.success, failures: lastErrors };
            },
            { maxRounds: verifyMaxRounds }
          );

          if (loop.success && pendingTxId) {
            await eventBus.publish("subagent:progress", {
              agentId: req.agentId,
              phase: "Committing changes...",
              elapsedMs: Date.now() - startTime,
            });
            // Atomic (journaled, crash-recoverable) commit when the flag is on;
            // otherwise the legacy best-effort per-file commit.
            const committed = getRuntimeFlags().atomicRollback
              ? stagingEngine.commitTransactionAtomic(pendingTxId, req.projectRoot)
              : await stagingEngine.commitTransaction(pendingTxId, req.projectRoot);
            pendingTxId = null;
            filesWritten.push(...committed);
          } else {
            // Verification never passed within budget → discard and surface.
            if (pendingTxId) {
              stagingEngine.discardTransaction(pendingTxId);
              pendingTxId = null;
            }
            throw new WorkspaceValidationError(`Workspace compile and validation checks failed:\n${lastErrors}`);
          }
        } catch (txErr) {
          if (pendingTxId) {
            stagingEngine.discardTransaction(pendingTxId);
            pendingTxId = null;
          }
          subagentStderr = txErr instanceof Error ? txErr.message : String(txErr);
          throw txErr;
        } finally {
          // Always release locks.
          for (const filePath of acquiredLocks) {
            lockManager.releaseLock(filePath, req.agentId);
          }
        }

        // Re-index the workspace to capture the new modifications
        try {
          const index = buildIndex(req.projectRoot);
          writeIndex(req.projectRoot, index);
        } catch {
          // Log or warn but do not halt
        }
      } else {
        // No legacy SEARCH/REPLACE suggestions, but files may have been written
        // directly by XML tool calls. Here the edits are already on disk (not
        // staged), so the verify loop re-runs the LLM (which re-edits via tools)
        // on a failure rather than re-staging. Acceptance = build + lint/test
        // (when on). Legacy (flags off): build-only, single attempt, throw — same
        // as before.
        const xmlAcceptanceCommands = buildAcceptanceCommands(req.projectRoot, {
          lint: getRuntimeFlags().verifyLint,
          test: getRuntimeFlags().verifyTests,
        });

        const runWorkspaceAcceptance = async (): Promise<{ passed: boolean; failures: string }> => {
          for (const cmd of xmlAcceptanceCommands) {
            const [bin, ...args] = cmd;
            const proc = execa(bin!, args, { cwd: req.projectRoot, reject: false, detached: true });
            WorkerRegistry.getInstance().register(proc);
            const res = await proc;
            if (res.exitCode !== 0) {
              return {
                passed: false,
                failures: (res.stderr || res.stdout || `${cmd.join(" ")} exited ${res.exitCode}`) as string,
              };
            }
          }
          return { passed: true, failures: "" };
        };

        const validateWithHeal = async (): Promise<void> => {
          const maxRounds = getRuntimeFlags().verifyLoop
            ? Math.max(1, getRuntimeFlags().verifyMaxRounds)
            : 1;
          let lastErr = "";
          const loop = await runVerifyLoop(
            async (ctx) => {
              if (ctx.round > 1) {
                await eventBus.publish("subagent:progress", {
                  agentId: req.agentId,
                  phase: `Self-healing (round ${ctx.round})`,
                  elapsedMs: Date.now() - startTime,
                });
                await withDeadline(
                  runChatTurnWithStream(
                    {
                      prompt:
                        req.task +
                        contextRefs +
                        `\n\n[Your previous changes failed verification. Fix these errors]\n` +
                        (ctx.previousFailures ?? ""),
                      projectRoot: req.projectRoot,
                      skillsRoot,
                      providerId: opts.providerId as any,
                      noLlm: opts.noLlm,
                      systemInstructionOverride,
                      agentId: req.agentId,
                      reasoningBudgetMultiplier: opts.reasoningBudgetMultiplier,
                      maxLoops: opts.maxLoops ?? 15,
                    },
                    { onRoute: () => {}, onDelta: () => {}, onThought: () => {} }
                  ),
                  deadlineMs,
                  req.agentId
                );
              }
            },
            async () => {
              await eventBus.publish("subagent:progress", {
                agentId: req.agentId,
                phase: "Validating changes (compiling & checking build)...",
                elapsedMs: Date.now() - startTime,
              });
              const r = await runWorkspaceAcceptance();
              lastErr = r.failures;
              return { passed: r.passed, failures: r.failures };
            },
            { maxRounds }
          );
          if (!loop.success) {
            subagentStderr = lastErr;
            throw new WorkspaceValidationError(`Workspace compile and validation checks failed:\n${lastErr}`);
          }
        };

        if (opts.originalProjectRoot) {
          const ws = { tempDir: req.projectRoot, projectRoot: opts.originalProjectRoot };
          const changes = detectWorkspaceChanges(ws);
          const uniqueModified = Array.from(new Set([...changes.createdOrModified, ...(chatTurnResult.filesWritten || [])]));
          if (uniqueModified.length > 0 || changes.deleted.length > 0) {
            filesWritten = uniqueModified;
            await validateWithHeal();
          }
        } else if (chatTurnResult.filesWritten && chatTurnResult.filesWritten.length > 0) {
          filesWritten = chatTurnResult.filesWritten;
          await validateWithHeal();
        }

        // Re-index the workspace to capture the new modifications
        if (filesWritten && filesWritten.length > 0) {
          try {
            const index = buildIndex(req.projectRoot);
            writeIndex(req.projectRoot, index);
          } catch {
            // Log or warn but do not halt
          }
        }
      }
    }
  } catch (err: any) {
    hasError = true;
    subagentStderr = subagentStderr || err?.message || String(err);
  }

  const payload: AgentDispatchPayload = {
    agentId: req.agentId,
    task: req.task,
    coordinatorRoute,
    subagentRoute: sub.route,
    suggestedCommands,
    disciplines: (() => {
      const custom = loadCustomAgents(req.projectRoot);
      return custom[req.agentId as string]?.disciplines ?? AGENT_DISCIPLINES[req.agentId as AgentId] ?? [];
    })(),
    agentPromptPath: subagentPromptPath(skillsRoot, req.agentId, req.projectRoot),
    subagentStdout,
    subagentStderr,
    llmResponse,
    filesWritten,
  };

  const stdout = JSON.stringify(payload, null, 2);
  const exitCode = (hasError || sub.exitCode !== 0) ? 1 : 0;

  // Feed the dispatch outcome back into the capability registry so future
  // rankForTask() decisions reflect this agent's live health and free its slot.
  capabilityRegistry.recordOutcome(req.agentId, exitCode === 0, exitCode === 0 ? undefined : subagentStderr);
  capabilityRegistry.markDone(req.agentId);

  const result: AgentDispatchResult = {
    agentId: req.agentId,
    exitCode,
    stdout,
    stderr: subagentStderr,
    isolatedEnv,
    payload,
  };

  const elapsedMs = Date.now() - startTime;
  if (exitCode === 0) {
    await eventBus.publish("subagent:finished", {
      agentId: req.agentId,
      status: "done",
      result: filesWritten?.length
        ? `Successfully edited: ${filesWritten.join(", ")}`
        : "Completed successfully with no files modified",
      exitCode: 0,
      elapsedMs,
      timestamp: Date.now(),
    }, { agentId: req.agentId as string, durationMs: elapsedMs, costUsd: subagentCostUsd });
  } else {
    await eventBus.publish("subagent:error", {
      agentId: req.agentId,
      status: "error",
      result: subagentStderr || "Subagent execution failed",
      exitCode: 1,
      elapsedMs,
      timestamp: Date.now(),
    }, { agentId: req.agentId as string, durationMs: elapsedMs, costUsd: subagentCostUsd });
  }

  logDispatch(req.projectRoot, req, result);
  return result;
}

export interface ParallelDispatchRequest {
  agentId: AgentId;
  task: string;
  contextFiles?: string[];
}

export interface ParallelDispatchResult {
  success: boolean;
  results: AgentDispatchResult[];
  mergeResult?: MergeResult;
  error?: string;
}

export async function dispatchAgentsParallel(
  projectRoot: string,
  dispatches: ParallelDispatchRequest[],
  opts: DispatchAgentOptions = {}
): Promise<ParallelDispatchResult> {
  const workspaces = dispatches.map((req) =>
    createIsolatedWorkspace(projectRoot, req.agentId)
  );

  const limit = Math.max(1, opts.maxParallelAgents ?? getRuntimeFlags().maxParallelAgents);
  const activeQueue: Array<() => void> = [];
  let activeCount = 0;

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (activeCount < limit) {
        activeCount++;
        resolve();
      } else {
        activeQueue.push(resolve);
      }
    });

  const release = () => {
    activeCount--;
    if (activeQueue.length > 0) {
      activeCount++;
      const next = activeQueue.shift();
      if (next) next();
    }
  };

  try {
    const promises = dispatches.map(async (req, index) => {
      const ws = workspaces[index]!;
      await acquire();
      try {
        // Budget gate: once the cost ceiling is depleted, stop launching NEW
        // agents instead of letting them run and collectively overshoot. Agents
        // already in flight finish normally. Closes the concurrent-overspend gap.
        if (globalCostGovernor.getGovernanceState().isDepleted) {
          const skipped: AgentDispatchResult = {
            agentId: req.agentId,
            exitCode: 1,
            stdout: "",
            stderr: `Skipped: cost budget exhausted before dispatch of "${req.agentId}".`,
            isolatedEnv: {},
          };
          await EventBus.getInstance().publish("subagent:skipped", {
            agentId: req.agentId,
            reason: "cost_budget_exhausted",
            timestamp: Date.now(),
          });
          return skipped;
        }
        return await dispatchAgent(
          {
            agentId: req.agentId,
            task: req.task,
            projectRoot: ws.tempDir,
            contextFiles: req.contextFiles,
          },
          {
            ...opts,
            originalProjectRoot: projectRoot,
          }
        );
      } finally {
        release();
      }
    });

    const results = await Promise.all(promises);

    // Partial-success safety: merge changes ONLY from successful agent workspaces
    const successfulWorkspaces = workspaces.filter((_, idx) => results[idx]?.exitCode === 0);
    const failedResults = results.filter((r) => r.exitCode !== 0);

    let mergeResult: MergeResult | undefined;
    if (successfulWorkspaces.length > 0) {
      mergeResult = mergeWorkspaceChanges(successfulWorkspaces, projectRoot);
      if (!mergeResult.success) {
        return {
          success: false,
          results,
          mergeResult,
          error: `Merge conflict detected in parallel workspaces: ${mergeResult.conflicts.join(", ")}`,
        };
      }
    }

    const allSucceeded = failedResults.length === 0;

    return {
      success: allSucceeded,
      results,
      mergeResult,
      error: failedResults.length > 0
        ? `Agent dispatch partially failed. Failed agents: ${failedResults.map((r) => r.agentId).join(", ")}`
        : undefined,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up all workspaces
    for (const ws of workspaces) {
      cleanIsolatedWorkspace(ws);
    }
  }
}

