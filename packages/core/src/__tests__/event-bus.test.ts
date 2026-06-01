import { describe, expect, it, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../events/event-bus.js";
import { ReplayEvent } from "@agency/contracts";

describe("EventBus Subsystem", () => {
  const eventBus = EventBus.getInstance();

  afterEach(() => {
    eventBus.clear();
  });

  it("should subscribe and receive events in chronological order", async () => {
    const received: ReplayEvent[] = [];
    
    eventBus.subscribe("test:action", (evt) => {
      received.push(evt);
    });

    const success1 = await eventBus.publish("test:action", { id: 1 });
    const success2 = await eventBus.publish("test:action", { id: 2 });

    expect(success1).toBe(true);
    expect(success2).toBe(true);

    // Wait for async cooperative queue drain
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(2);
    expect(received[0].sequenceId).toBe(1);
    expect(received[0].payload).toBe(JSON.stringify({ id: 1 }));
    expect(received[1].sequenceId).toBe(2);
    expect(received[1].payload).toBe(JSON.stringify({ id: 2 }));
  });

  it("should deduplicate duplicate event payloads within the sliding window", async () => {
    const received: ReplayEvent[] = [];
    
    eventBus.subscribe("test:dedup", (evt) => {
      received.push(evt);
    });

    // First publish is successful
    const pub1 = await eventBus.publish("test:dedup", { message: "hello" });
    // Second publish with same payload is deduplicated (returns false)
    const pub2 = await eventBus.publish("test:dedup", { message: "hello" });
    // Third publish with different payload is successful
    const pub3 = await eventBus.publish("test:dedup", { message: "world" });

    expect(pub1).toBe(true);
    expect(pub2).toBe(false);
    expect(pub3).toBe(true);

    // Wait for async cooperative queue drain
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(2);
    expect(received[0].payload).toBe(JSON.stringify({ message: "hello" }));
    expect(received[1].payload).toBe(JSON.stringify({ message: "world" }));
  });

  it("delivers oversized payloads as a small ref and spills the original async (never a sync write on the publish path)", async () => {
    const received: ReplayEvent[] = [];

    eventBus.subscribe("test:large", (evt) => {
      received.push(evt);
    });

    // > MAX_EVENT_BYTES (8KB). Regression guard: a subagent re-publishing its
    // full accumulated transcript per token used to issue one synchronous file
    // write per token here, starving the event loop and freezing the TUI.
    const big = "x".repeat(9 * 1024);
    const ok = await eventBus.publish("test:large", { blob: big });
    expect(ok).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));

    // The delivered/journaled event carries a tiny ref, never the raw payload.
    expect(received).toHaveLength(1);
    const delivered = JSON.parse(received[0].payload) as { refId?: string; summary?: string };
    expect(delivered.refId).toBeTruthy();
    expect(delivered.summary).toContain("Truncated large payload");
    expect(received[0].payload.length).toBeLessThan(1024);

    // The original is recoverable from the fire-and-forget spill file. The spill
    // is an eventual async write (fs/promises), so await the bus's real
    // write-completion signal rather than racing existsSync against a
    // half-flushed file — existsSync goes true the moment writeFile opens the
    // fd, before the bytes are flushed and closed, which under heavy concurrent
    // load (e.g. `pnpm -r test` saturating the CPU across all packages) let a
    // truncated read surface as `Unexpected end of JSON input`. awaitSpill
    // resolves only after writeFile has flushed AND closed, so the read below is
    // deterministic. This does not touch the production async-spill behaviour:
    // publish still spills fire-and-forget off the hot path (no sync write).
    await eventBus.awaitSpill(delivered.refId!);
    const spillPath = join(".agency", "large-payloads", `${delivered.refId}.json`);
    expect(existsSync(spillPath)).toBe(true);
    const spilled = JSON.parse(readFileSync(spillPath, "utf8")) as { blob: string };
    expect(spilled.blob).toBe(big);
    rmSync(spillPath, { force: true });
  });

  it("never rejects on a non-serialisable payload so `void publish(...)` can't crash the host", async () => {
    const received: ReplayEvent[] = [];
    eventBus.subscribe("test:circular", (evt) => received.push(evt));

    // Circular reference → JSON.stringify throws. Regression guard: most callers
    // use `void eventBus.publish(...)`, so a rejection here becomes an unhandled
    // rejection that (before the global handler was made non-fatal) tore the TUI
    // down and dropped the user to the shell.
    const circular: any = { name: "loop" };
    circular.self = circular;

    await expect(eventBus.publish("test:circular", circular)).resolves.toBe(true);

    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(1);
    expect(typeof received[0]!.payload).toBe("string");
  });

  it("should support wildcard subscriptions", async () => {
    const received: ReplayEvent[] = [];
    
    eventBus.subscribe("*", (evt) => {
      received.push(evt);
    });

    await eventBus.publish("user:login", { user: "alice" });
    await eventBus.publish("file:edit", { file: "src/index.ts" });

    // Wait for async cooperative queue drain
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(2);
    expect(received[0].action).toBe("user:login");
    expect(received[1].action).toBe("file:edit");
  });
});
