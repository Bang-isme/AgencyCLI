import { describe, expect, it } from "vitest";
import { getRuntimeFlags } from "@agency/core";
import { buildFlagRows } from "../commands/status.js";

/**
 * Completeness guard for the human `agency status` flag view.
 *
 * The human output used to hand-pick which flags to print and silently omitted
 * several behaviour-changing ones (secretScan, atomicRollback, checkpointStrict,
 * mcpRequestTimeoutMs, verifyMainTurn, traceRecord, maxCrashLoops) — so a user on
 * `AGENCY_PROFILE=hardened` couldn't see they were active. `buildFlagRows` is now
 * the single declarative source for that view; this test asserts every flag in
 * `getRuntimeFlags()` is covered by some row, so a newly-added flag can't be
 * introduced without surfacing it (the same "wired but not observable" defect
 * class the initiative targets). Numeric tunables are folded into a parent row
 * but must still be declared as covered.
 */

const sorted = (xs: string[]) => [...xs].sort();

describe("agency status — flag view completeness", () => {
  it("surfaces every runtime flag (no silent omission)", () => {
    const flags = getRuntimeFlags();
    const allKeys = Object.keys(flags).filter((k) => k !== "profile");
    const covered = new Set(buildFlagRows(flags).flatMap((r) => r.keys as string[]));
    expect(sorted([...covered])).toEqual(sorted(allKeys));
  });

  it("renders a non-empty label and value for each row", () => {
    for (const row of buildFlagRows(getRuntimeFlags())) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(String(row.value).length).toBeGreaterThan(0);
      expect(row.keys.length).toBeGreaterThan(0);
    }
  });

  it("reflects hardened behaviour flags as on (previously hidden ones included)", () => {
    const hardened = getRuntimeFlags({ AGENCY_PROFILE: "hardened" } as NodeJS.ProcessEnv);
    const rows = buildFlagRows(hardened);
    const byKey = (k: string) => rows.find((r) => (r.keys as string[]).includes(k));
    expect(byKey("secretScan")!.value).toMatch(/^on/);
    expect(byKey("atomicRollback")!.value).toBe("on");
    expect(byKey("checkpointStrict")!.value).toMatch(/^on/);
  });
});
