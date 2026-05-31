import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReplayEvent } from "@agency/contracts";

export type EventCallback = (event: ReplayEvent) => void | Promise<void>;

/**
 * Durable sink the EventBus mirrors every accepted event into. Implemented by
 * {@link EventJournal}. Kept structural so the bus has no hard dependency on the
 * SQLite layer and tests can supply a fake.
 */
export interface DurableEventSink {
  appendEvent(event: ReplayEvent): void;
  readEvents?(): ReplayEvent[];
}

/** Maximum number of events stored in the journal before trimming */
const MAX_JOURNAL_SIZE = 10_000;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024; // 32MB max
const MAX_EVENT_BYTES = 8 * 1024; // 8KB max

export class EventBus {
  private static instance: EventBus;
  private subscribers = new Map<string, Set<EventCallback>>();
  private journal: ReplayEvent[] = [];
  private sequenceCounter = 0;
  
  // 5-second sliding window for deduplication
  private seenHashes = new Map<string, number>();
  private deduplicateWindowMs = 5000;

  // Bounded priority queues
  private queues = {
    CRITICAL: [] as ReplayEvent[],
    HIGH: [] as ReplayEvent[],
    NORMAL: [] as ReplayEvent[],
    LOW: [] as ReplayEvent[]
  };
  private currentQueueBytes = 0;
  private isDraining = false;

  // Optional durable mirror. When attached, every accepted event is appended
  // synchronously so a crash cannot lose the in-memory tail. Defaults to off
  // to preserve legacy (memory-only) behaviour.
  private durableSink: DurableEventSink | null = null;

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public clear(): void {
    this.subscribers.clear();
    this.journal = [];
    this.sequenceCounter = 0;
    this.seenHashes.clear();
    this.queues.CRITICAL = [];
    this.queues.HIGH = [];
    this.queues.NORMAL = [];
    this.queues.LOW = [];
    this.currentQueueBytes = 0;
    this.isDraining = false;
    this.durableSink = null;
  }

  /**
   * Attaches a durable sink and warm-loads the in-memory journal + sequence
   * counter from it, so a restarted process continues the event stream instead
   * of restarting numbering at 1. Idempotent-safe: re-attaching re-syncs the
   * counter. Failures here never throw — durability is best-effort and must not
   * block startup.
   */
  public attachDurableJournal(sink: DurableEventSink): void {
    this.durableSink = sink;
    try {
      const prior = sink.readEvents?.() ?? [];
      if (prior.length > 0) {
        // Restore the tail into the bounded in-memory journal for replay/inspection.
        this.journal = prior.slice(Math.max(0, prior.length - MAX_JOURNAL_SIZE));
        const maxSeq = prior.reduce((m, e) => (e.sequenceId > m ? e.sequenceId : m), 0);
        if (maxSeq > this.sequenceCounter) {
          this.sequenceCounter = maxSeq;
        }
      }
    } catch (err) {
      this.handleSubscriberError("durable-warmload", err);
    }
  }

  /** Detaches the durable sink (used in tests / shutdown). */
  public detachDurableJournal(): void {
    this.durableSink = null;
  }

  /**
   * Subscribes to a topic.
   */
  public subscribe(actionPattern: string, callback: EventCallback): void {
    if (!this.subscribers.has(actionPattern)) {
      this.subscribers.set(actionPattern, new Set());
    }
    this.subscribers.get(actionPattern)!.add(callback);
  }

  /**
   * Unsubscribes from a topic.
   */
  public unsubscribe(actionPattern: string, callback: EventCallback): void {
    const subs = this.subscribers.get(actionPattern);
    if (subs) {
      subs.delete(callback);
    }
  }

  /**
   * Returns true if queue memory is backpressured (over 50% capacity).
   */
  public isBackpressured(): boolean {
    return this.currentQueueBytes > MAX_QUEUE_BYTES * 0.5;
  }

  /**
   * Publishes an event to the bus. Returns true if delivered/queued, false if deduplicated or shed.
   *
   * `meta` carries optional attribution (agent/task/duration/cost) for forensics
   * and per-agent cost accounting. It is recorded on the event and persisted but
   * never folded into the dedup/replay hash, so it can't change replay behaviour.
   */
  public async publish(
    action: string,
    payload: any,
    meta?: { agentId?: string; taskId?: string; durationMs?: number; costUsd?: number }
  ): Promise<boolean> {
    // Never let a non-serialisable payload (circular ref / BigInt) make publish
    // reject: most callers use `void eventBus.publish(...)`, and an unhandled
    // rejection there can tear the whole TUI down. Fall back to a safe string.
    let payloadStr: string;
    try {
      payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (payloadStr === undefined) payloadStr = String(payload);
    } catch {
      try {
        payloadStr = String(payload);
      } catch {
        payloadStr = "[unserialisable payload]";
      }
    }
    const hash = createHash("sha256").update(action + ":" + payloadStr).digest("hex");
    
    const now = Date.now();
    this.cleanupDeduplicationCache(now);

    if (this.seenHashes.has(hash)) {
      return false; // Deduplicated!
    }

    this.seenHashes.set(hash, now);
    
    this.sequenceCounter++;

    let finalPayload = payloadStr;
    let refId: string | undefined;

    // Check individual event size budget. Oversized payloads are replaced by a
    // small ref in the journal/delivery and spilled to disk for forensics. The
    // spill is async (libuv threadpool) and fire-and-forget: doing it
    // synchronously here put one blocking file write on the publish hot path, so
    // a high-frequency stream of large events (e.g. a subagent re-publishing its
    // full accumulated transcript per token) would starve the event loop and
    // freeze the TUI. The ref is only read for offline forensics, so a
    // best-effort async write is the right trade-off.
    const payloadSize = Buffer.byteLength(payloadStr);
    if (payloadSize > MAX_EVENT_BYTES) {
      refId = `ref-${Math.random().toString(36).substring(2, 9)}-${Date.now()}`;
      finalPayload = JSON.stringify({
        refId,
        summary: `Truncated large payload. Original size: ${payloadSize} bytes.`
      });
      void this.spillLargePayload(refId, payloadStr);
    }

    const prio = this.getPriority(action);
    const eventSize = Buffer.byteLength(finalPayload) + Buffer.byteLength(action);

    // Shedding logic
    if (prio === "LOW" && this.currentQueueBytes + eventSize > MAX_QUEUE_BYTES * 0.8) {
      return false; // Shed logs under load
    }
    if ((prio === "LOW" || prio === "NORMAL") && this.currentQueueBytes + eventSize > MAX_QUEUE_BYTES) {
      return false; // Bounded memory ceiling
    }
    
    const event: ReplayEvent = {
      sequenceId: this.sequenceCounter,
      timestamp: now,
      action,
      payloadHash: hash,
      payload: finalPayload,
      ...(meta?.agentId !== undefined ? { agentId: meta.agentId } : {}),
      ...(meta?.taskId !== undefined ? { taskId: meta.taskId } : {}),
      ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta?.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
    };

    // Attach priority dynamically
    (event as any).priority = prio;

    this.journal.push(event);
    if (this.journal.length > MAX_JOURNAL_SIZE) {
      this.journal = this.journal.slice(Math.floor(MAX_JOURNAL_SIZE * 0.2));
    }

    // Durable mirror: append before queueing for delivery so a crash mid-drain
    // still preserves the event. Best-effort — never let a journal write abort
    // the publish path.
    if (this.durableSink) {
      try {
        this.durableSink.appendEvent(event);
      } catch (err) {
        this.handleSubscriberError("durable-append", err);
      }
    }

    this.queues[prio].push(event);
    this.currentQueueBytes += eventSize;

    this.scheduleDrain();
    return true;
  }

  /**
   * Returns the entire event history.
   */
  public getJournal(): ReplayEvent[] {
    return [...this.journal];
  }

  private cleanupDeduplicationCache(now: number): void {
    const expired: string[] = [];
    for (const [hash, time] of this.seenHashes) {
      if (now - time > this.deduplicateWindowMs) {
        expired.push(hash);
      }
    }
    for (const hash of expired) {
      this.seenHashes.delete(hash);
    }
  }

  private getPriority(action: string): "CRITICAL" | "HIGH" | "NORMAL" | "LOW" {
    const act = action.toLowerCase();
    if (act.includes("cancel") || act.includes("exit") || act.includes("error") || act.includes("abort") || act.includes("approval")) {
      return "CRITICAL";
    }
    if (act.includes("started") || act.includes("completed") || act.includes("failed")) {
      return "HIGH";
    }
    if (act.includes("progress") || act.includes("state") || act.includes("status")) {
      return "NORMAL";
    }
    return "LOW";
  }

  private scheduleDrain(): void {
    if (this.isDraining) return;
    this.isDraining = true;

    const scheduleAsync = typeof setImmediate === "function"
      ? setImmediate
      : (fn: () => void) => setTimeout(fn, 0);

    scheduleAsync(() => this.drainQueue());
  }

  private async drainQueue(): Promise<void> {
    const startTime = performance.now();
    const budgetMs = 4; // 4ms budget per event loop tick

    const quotas = {
      CRITICAL: 4,
      HIGH: 3,
      NORMAL: 2,
      LOW: 1
    };

    const scheduleAsync = typeof setImmediate === "function"
      ? setImmediate
      : (fn: () => void) => setTimeout(fn, 0);

    while (true) {
      const totalEvents =
        this.queues.CRITICAL.length +
        this.queues.HIGH.length +
        this.queues.NORMAL.length +
        this.queues.LOW.length;

      if (totalEvents === 0) {
        this.isDraining = false;
        break;
      }

      // Check time budget
      if (performance.now() - startTime > budgetMs) {
        // Yield thread and schedule next pass
        scheduleAsync(() => this.drainQueue());
        break;
      }

      let processedAny = false;
      for (const [prioKey, limit] of Object.entries(quotas)) {
        const q = this.queues[prioKey as keyof typeof quotas];
        let count = 0;
        while (q.length > 0 && count < limit) {
          const event = q.shift()!;
          const eventSize = Buffer.byteLength(event.payload) + Buffer.byteLength(event.action);
          this.currentQueueBytes = Math.max(0, this.currentQueueBytes - eventSize);

          this.deliverEvent(event);
          processedAny = true;
          count++;
        }
      }

      // Starvation fallback: if some quotas are unused but others have items
      if (!processedAny) {
        const activeQueue =
          this.queues.CRITICAL.length ? this.queues.CRITICAL :
          this.queues.HIGH.length ? this.queues.HIGH :
          this.queues.NORMAL.length ? this.queues.NORMAL :
          this.queues.LOW;

        if (activeQueue.length > 0) {
          const event = activeQueue.shift()!;
          const eventSize = Buffer.byteLength(event.payload) + Buffer.byteLength(event.action);
          this.currentQueueBytes = Math.max(0, this.currentQueueBytes - eventSize);
          this.deliverEvent(event);
        } else {
          this.isDraining = false;
          break;
        }
      }
    }
  }

  private deliverEvent(event: ReplayEvent): void {
    const topics = [event.action, "*"];
    for (const topic of topics) {
      const subs = this.subscribers.get(topic);
      if (subs) {
        for (const cb of subs) {
          try {
            const res = cb(event);
            if (res instanceof Promise) {
              res.catch((err) => this.handleSubscriberError(topic, err));
            }
          } catch (err) {
            this.handleSubscriberError(topic, err);
          }
        }
      }
    }
  }

  /**
   * Best-effort async spill of an oversized payload to disk. Never throws and
   * never runs on the publish hot path — losing a forensic payload must not
   * break (or block) event delivery.
   */
  private async spillLargePayload(refId: string, payload: string): Promise<void> {
    try {
      const dir = join(".agency", "large-payloads");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${refId}.json`), payload, "utf8");
    } catch (err) {
      this.handleSubscriberError("large-payload-spill", err);
    }
  }

  private handleSubscriberError(topic: string, err: any): void {
    const msg = `EventBus subscriber error on topic "${topic}": ${err instanceof Error ? err.message : String(err)}`;
    if (typeof (globalThis as any).onAgencyEventBusError === "function") {
      (globalThis as any).onAgencyEventBusError(msg);
    } else {
      process.stderr.write(msg + "\n");
    }
  }
}
