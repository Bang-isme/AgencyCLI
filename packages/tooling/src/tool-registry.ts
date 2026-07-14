import { z } from "zod";
import { ExecutionContext } from "@agency/contracts";

import { CoercionLayer } from "./coercion-layer.js";

export interface ToolMetadata<T = any, R = any> {
  semanticAction: string;
  targetExtractor: (args: T) => string;
  resultSummarizer: (args: T, result: R) => string;
  risk: "low" | "medium" | "high";
  prerequisite: string;
  recovery: string;
}

export interface ToolDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: T;
  category: "read" | "write" | "compile" | "test" | "other";
  execute: (args: z.infer<T>, context: ExecutionContext) => Promise<any>;
  metadata: ToolMetadata<z.infer<T>, any>;
}

/**
 * Structured result of a fail-safe tool invocation. `invokeSafe` never throws,
 * so callers can treat any tool failure (validation, timeout, hook rejection,
 * thrown handler) as data rather than an exception that crashes the runtime.
 */
export interface SafeInvokeResult {
  ok: boolean;
  result?: any;
  error?: string;
  /** Coarse failure classification for telemetry / retry policy. */
  errorKind?: "not_registered" | "validation" | "timeout" | "hook" | "execution";
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any>>();
  private preExecuteHooks: ((name: string, args: any, context: ExecutionContext) => void | Promise<void>)[] = [];
  private postExecuteHooks: ((name: string, args: any, result: any, context: ExecutionContext) => void | Promise<void>)[] = [];

  public register<T extends z.ZodTypeAny>(tool: ToolDefinition<T>): void {
    if (!tool.metadata) {
      throw new Error(`Tool registration failed: Tool "${tool.name}" is missing metadata.`);
    }
    const { semanticAction, targetExtractor, resultSummarizer, risk, prerequisite, recovery } = tool.metadata;
    if (
      semanticAction === undefined ||
      targetExtractor === undefined ||
      resultSummarizer === undefined ||
      risk === undefined ||
      prerequisite === undefined ||
      recovery === undefined
    ) {
      throw new Error(
        `Tool registration failed: Tool "${tool.name}" metadata is incomplete. Required fields: semanticAction, targetExtractor, resultSummarizer, risk, prerequisite, recovery.`
      );
    }
    this.tools.set(tool.name, tool);
  }

  public get<T extends z.ZodTypeAny>(name: string): ToolDefinition<T> | undefined {
    return this.tools.get(name);
  }

  public listTools(): ToolDefinition<any>[] {
    return Array.from(this.tools.values());
  }

  public addPreExecuteHook(hook: (name: string, args: any, context: ExecutionContext) => void | Promise<void>): void {
    this.preExecuteHooks.push(hook);
  }

  public addPostExecuteHook(hook: (name: string, args: any, result: any, context: ExecutionContext) => void | Promise<void>): void {
    this.postExecuteHooks.push(hook);
  }

  /**
   * Invokes a tool, validating inputs, enforcing category-specific timeouts, and running governance hooks.
   */
  public async invoke(name: string, rawArgs: any, context: ExecutionContext): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered.`);
    }

    // 1. Coerce and validate using CoercionLayer
    const coercionLayer = new CoercionLayer();
    const validation = coercionLayer.coerceAndValidateZod(rawArgs, tool.schema);
    if (!validation.success) {
      throw new Error(`Validation failed for tool "${name}": ${validation.errors?.join(", ")}`);
    }
    const parsedArgs = validation.data;

    // 2. Pre-execution governance checks
    try {
      for (const hook of this.preExecuteHooks) {
        await hook(name, parsedArgs, context);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      (error as any).isHookError = true;
      throw error;
    }

    // 3. Category-dependent timeouts (with custom multiplier)
    let multiplier = 1.0;
    if (process.env.AGENCY_TIMEOUT_MULTIPLIER) {
      const val = parseFloat(process.env.AGENCY_TIMEOUT_MULTIPLIER);
      if (!isNaN(val) && val > 0) {
        multiplier = val;
      }
    }

    // 10s for reads, 30s for writes, 120s for compiles/tests, 30s other
    let timeoutMs = 30000;
    if (tool.category === "read") {
      timeoutMs = 10000;
    } else if (tool.category === "write") {
      timeoutMs = 30000;
    } else if (tool.category === "compile" || tool.category === "test") {
      timeoutMs = 120000;
    }

    timeoutMs = Math.round(timeoutMs * multiplier);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution for "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        tool.execute(parsedArgs, context),
        timeoutPromise,
      ]);

      // 4. Post-execution hooks (e.g. token budget counting)
      try {
        for (const hook of this.postExecuteHooks) {
          await hook(name, parsedArgs, result, context);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        (error as any).isHookError = true;
        throw error;
      }

      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Fail-safe wrapper around {@link invoke} that NEVER throws. Returns a
   * structured {@link SafeInvokeResult} so a buggy tool, a validation failure,
   * a timeout, or a rejecting governance hook cannot crash the host runtime.
   *
   * Spec: "Tool failures must never crash the runtime."
   */
  public async invokeSafe(
    name: string,
    rawArgs: any,
    context: ExecutionContext
  ): Promise<SafeInvokeResult> {
    if (!this.tools.has(name)) {
      return { ok: false, error: `Tool "${name}" is not registered.`, errorKind: "not_registered" };
    }
    try {
      const result = await this.invoke(name, rawArgs, context);
      return { ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let errorKind: SafeInvokeResult["errorKind"] = "execution";
      if (msg.startsWith("Validation failed")) errorKind = "validation";
      else if (msg.includes("timed out")) errorKind = "timeout";
      else if (err && typeof err === "object" && (err as any).isHookError) errorKind = "hook";
      return { ok: false, error: msg, errorKind };
    }
  }
}
