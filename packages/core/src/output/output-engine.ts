import type {
  OutputEvent,
  OutputResult,
  OutputFailure,
  OutputPatch,
  OutputTable,
  OutputWorkerStatus,
  OutputTrustBadge,
  OutputEngineConfig,
} from "./output-types.js";
import { applyOutputFilter } from "./filters/output-filter.js";
import { formatEvent } from "./formatters/event-formatter.js";
import { formatFailure } from "./formatters/failure-formatter.js";
import { formatResult } from "./formatters/result-formatter.js";
import { formatPatch } from "./formatters/patch-formatter.js";
import { formatTable } from "./formatters/table-formatter.js";
import { formatPhase } from "./formatters/phase-formatter.js";
import { formatElapsed } from "./utils/time-format.js";

export class OutputEngine {
  private static _instance: OutputEngine | null = null;
  private config: OutputEngineConfig;

  constructor(config?: Partial<OutputEngineConfig>) {
    this.config = {
      surface: "human",
      quiet: false,
      color: true,
      ...config,
    };
  }

  static shared(config?: Partial<OutputEngineConfig>): OutputEngine {
    if (!OutputEngine._instance) {
      OutputEngine._instance = new OutputEngine(config);
    } else if (config) {
      OutputEngine._instance.configure(config);
    }
    return OutputEngine._instance;
  }

  static reset(): void {
    OutputEngine._instance = null;
  }

  configure(config: Partial<OutputEngineConfig>): void {
    Object.assign(this.config, config);
  }

  emit(event: OutputEvent): void {
    this.write(formatEvent(event, this.config));
  }

  phase(label: string, meta?: Record<string, string>): void {
    this.write(formatPhase({ label, meta }, this.config));
  }

  result(data: OutputResult | Array<{ key: string; value: string }>): void {
    const normalized: OutputResult = Array.isArray(data)
      ? { entries: data }
      : data;
    this.write(formatResult(normalized, this.config));
  }

  failure(data: OutputFailure): void {
    this.writeError(formatFailure(data, this.config));
  }

  patch(data: OutputPatch): void {
    this.write(formatPatch(data, this.config));
  }

  table(
    headers: string[],
    rows: string[][],
    opts?: { title?: string; compact?: boolean },
  ): void {
    const data: OutputTable = { headers, rows, ...opts };
    this.write(formatTable(data, this.config));
  }

  status(label: string, value: string): void {
    this.write(`  ${label}  ${value}`);
  }

  worker(data: OutputWorkerStatus): void {
    if (this.config.surface === "json") {
      this.write(JSON.stringify({ type: "worker", ...data }));
      return;
    }
    const elapsed =
      data.elapsedMs !== undefined ? ` (${formatElapsed(data.elapsedMs)})` : "";
    const task = data.task ? ` · ${data.task}` : "";
    this.write(`[${data.workerId}] ${data.status}${task}${elapsed}`);
  }

  trust(data: OutputTrustBadge): void {
    if (this.config.surface === "json") {
      this.write(JSON.stringify({ type: "trust", ...data }));
      return;
    }
    const parts: string[] = [];
    if (data.risk) parts.push(`risk: ${data.risk}`);
    if (data.confidence) parts.push(`confidence: ${data.confidence}`);
    if (data.validation) parts.push(`validation: ${data.validation}`);
    if (data.rollbackReady) parts.push("rollback: ready");
    if (parts.length > 0) {
      this.write(parts.join("  \u00b7  "));
    }
  }

  passthrough(text: string): void {
    if (!text) return;
    if (this.config.surface === "json") {
      this.write(text);
      return;
    }
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }

  meta(text: string): void {
    if (this.config.quiet) return;
    process.stderr.write(applyOutputFilter(text) + "\n");
  }

  json(data: unknown): void {
    this.write(JSON.stringify(data, null, 2));
  }

  private write(text: string): void {
    if (!text) return;
    const filtered =
      this.config.surface === "json" ? text : applyOutputFilter(text);
    process.stdout.write(filtered + "\n");
  }

  private writeError(text: string): void {
    if (!text) return;
    const filtered =
      this.config.surface === "json" ? text : applyOutputFilter(text);
    process.stderr.write(filtered + "\n");
  }
}
