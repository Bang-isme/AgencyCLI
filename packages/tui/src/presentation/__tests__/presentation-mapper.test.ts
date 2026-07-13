import { describe, expect, it } from "vitest";
import {
  PresentationMapper,
  formatDuration,
} from "../presentation-mapper.js";
import { THEMES } from "../../themes/registry.js";
import type { ActionLifecycleEvent, ActionLifecycleState } from "@agency/core";
import { capabilityRegistry } from "@agency/core";
import { filterSlashMenu, getSlashQuery } from "../slash-menu.js";

const theme = THEMES.agency!;

describe("PresentationMapper & Dynamic Menu Rendering - Empirical Stress Tests", () => {
  const allStates: ActionLifecycleState[] = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "incomplete",
    "cancelled",
  ];

  describe("Requirement 1: All 6 ActionLifecycleState values", () => {
    it.each(allStates)(
      "handles state '%s' gracefully without crashing or returning invalid UI models",
      (state) => {
        const event: ActionLifecycleEvent = {
          id: `evt-${state}`,
          label: `Action ${state}`,
          state,
          startedAt: Date.now() - 1000,
          durationMs: 1000,
          summary: `Summary for ${state}`,
        };

        const compact = PresentationMapper.mapToCompactRow(event, theme);
        expect(compact.id).toBe(event.id);
        expect(compact.status).toBe(state);
        expect(typeof compact.glyph).toBe("string");
        expect(compact.glyph.length).toBeGreaterThan(0);
        expect(compact.glyphColor).toBeDefined();

        const expanded = PresentationMapper.mapToExpandedDetail(event, theme);
        expect(expanded.id).toBe(event.id);
        expect(expanded.title).toBe(event.label);
        expect(expanded.durationMs).toBe(1000);
        expect(expanded.formattedDuration).toBe("1.0s");

        const recovery = PresentationMapper.mapToRecoveryCTA(event);
        expect(recovery).toBeDefined();
        expect(Array.isArray(recovery.keyShortcuts)).toBe(true);

        const full = PresentationMapper.mapToFullPresentation(event, theme);
        expect(full.compact).toBeDefined();
        expect(full.expanded).toBeDefined();
        expect(full.recovery).toBeDefined();
      }
    );

    it("verifies specific glyphs and colors for each state", () => {
      const baseEvent = (state: ActionLifecycleState): ActionLifecycleEvent => ({
        id: `evt-${state}`,
        label: `Test ${state}`,
        state,
      });

      expect(PresentationMapper.mapToCompactRow(baseEvent("queued"), theme)).toMatchObject({
        glyph: "◇",
        glyphColor: "muted",
      });

      expect(PresentationMapper.mapToCompactRow(baseEvent("running"), theme, { tick: 0 })).toMatchObject({
        glyph: "◜",
        glyphColor: "accent",
      });

      expect(PresentationMapper.mapToCompactRow(baseEvent("succeeded"), theme)).toMatchObject({
        glyph: "◆",
        glyphColor: "success",
      });

      expect(PresentationMapper.mapToCompactRow(baseEvent("failed"), theme)).toMatchObject({
        glyph: "✕",
        glyphColor: "danger",
      });

      expect(PresentationMapper.mapToCompactRow(baseEvent("incomplete"), theme)).toMatchObject({
        glyph: "⏸",
        glyphColor: "warning",
      });

      expect(PresentationMapper.mapToCompactRow(baseEvent("cancelled"), theme)).toMatchObject({
        glyph: "○",
        glyphColor: "muted",
      });
    });
  });

  describe("Requirement 2: Edge-case Payloads", () => {
    it("handles huge log output (100k lines / 5MB string) without crashing", () => {
      const hugeLog = "LOG LINE: " + "A".repeat(100) + "\n";
      const hugeDetail = hugeLog.repeat(50000); // 50,000 lines, ~5.5MB

      const event: ActionLifecycleEvent = {
        id: "evt-huge-log",
        label: "Execute huge process",
        state: "succeeded",
        rawDetail: hugeDetail,
      };

      const expanded = PresentationMapper.mapToExpandedDetail(event, theme);
      expect(expanded.rawDetail).toBe(hugeDetail);
      expect(expanded.codeBlock).toBeDefined();
      expect(expanded.codeBlock?.content.length).toBe(hugeDetail.length);
      expect(expanded.codeBlock?.language).toBe("json");
    });

    it("handles exec category huge log with bash syntax formatting", () => {
      const hugeLog = "npm test\n" + "line\n".repeat(100);
      const event: ActionLifecycleEvent = {
        id: "evt-exec-log",
        label: "Run tests",
        state: "failed",
        semantic: { category: "exec", label: "exec:npm test" },
        rawDetail: hugeLog,
      };

      const expanded = PresentationMapper.mapToExpandedDetail(event, theme);
      expect(expanded.codeBlock?.language).toBe("bash");
    });

    it("handles missing target, missing agentId, missing semantic gracefully", () => {
      const event: ActionLifecycleEvent = {
        id: "evt-missing-target",
        label: "Standalone Action",
        state: "succeeded",
      };

      const compact = PresentationMapper.mapToCompactRow(event, theme);
      expect(compact.label).toBe("Standalone Action");
      expect(compact.sublabel).toBeUndefined();

      const eventWithWorker: ActionLifecycleEvent = {
        id: "evt-worker",
        label: "Worker Action",
        state: "running",
        agentId: "subagent-99",
      };

      const compactWorker = PresentationMapper.mapToCompactRow(eventWithWorker, theme);
      expect(compactWorker.sublabel).toBe("worker.subagent-99");

      const eventWithMain: ActionLifecycleEvent = {
        id: "evt-main",
        label: "Main Action",
        state: "running",
        agentId: "main",
      };
      const compactMain = PresentationMapper.mapToCompactRow(eventWithMain, theme);
      expect(compactMain.sublabel).toBeUndefined();
    });

    it("handles non-string rawDetail.summary without crashing", () => {
      const eventWithObjSummary: ActionLifecycleEvent = {
        id: "evt-obj-summary",
        label: "Action with Object rawDetail.summary",
        state: "failed",
        rawDetail: {
          summary: { code: 500, message: "Internal server error" } as any,
        },
      };

      // Safely converts rawDetail.summary to string without throwing TypeError
      const expanded = PresentationMapper.mapToExpandedDetail(eventWithObjSummary, theme);
      expect(expanded.rawDetail).toBe("[object Object]");
    });

    it("populates keyShortcuts consistently when hasRecovery is true", () => {
      const eventWithRecoveryOnSuccess: ActionLifecycleEvent = {
        id: "evt-success-recovery",
        label: "Succeeded with recovery hint",
        state: "succeeded",
        recoveryHint: {
          suggestion: "Notice: service requires restart for full effect",
          suggestedAction: "service:restart",
        },
      };

      const recovery = PresentationMapper.mapToRecoveryCTA(eventWithRecoveryOnSuccess);
      expect(recovery.hasRecovery).toBe(true);
      expect(recovery.recoveryMessage).toBe("Notice: service requires restart for full effect");
      expect(recovery.defaultAction).toBe("service:restart");
      // KeyShortcuts are populated when hasRecovery is true
      expect(recovery.keyShortcuts.length).toBeGreaterThan(0);
    });

    it("populates keyShortcuts on cancelled state with recovery hint", () => {
      const eventCancelledWithHint: ActionLifecycleEvent = {
        id: "evt-cancelled-recovery",
        label: "Cancelled with recovery hint",
        state: "cancelled",
        recoveryHint: {
          suggestion: "Operation cancelled mid-flight. Clean up temporary files?",
          suggestedAction: "cleanup",
        },
      };

      const recovery = PresentationMapper.mapToRecoveryCTA(eventCancelledWithHint);
      expect(recovery.hasRecovery).toBe(true);
      expect(recovery.recoveryMessage).toBe("Operation cancelled mid-flight. Clean up temporary files?");
      expect(recovery.defaultAction).toBe("cleanup");
      // Key shortcuts are populated because hasRecovery is true
      expect(recovery.keyShortcuts.length).toBeGreaterThan(0);
    });

    it("handles duration formatting for extreme duration values", () => {
      expect(formatDuration(undefined)).toBe("");
      expect(formatDuration(0)).toBe("0ms");
      expect(formatDuration(999)).toBe("999ms");
      expect(formatDuration(1000)).toBe("1.0s");
      expect(formatDuration(12500)).toBe("12.5s");
      expect(formatDuration(1e12)).toBe("1000000000.0s");
    });
  });

  describe("Dynamic Menu Rendering & Slash Menu Integration", () => {
    it("dynamically queries capabilities registered in core capabilityRegistry", () => {
      const listBefore = filterSlashMenu("");
      expect(Array.isArray(listBefore)).toBe(true);

      // Register dynamic custom capability
      capabilityRegistry.register({
        id: "empiric-test-cmd",
        description: "Empirical test capability",
        tier: "core",
        surfaces: ["tui"],
        category: "exec",
        icon: "⚡",
      });

      const listAfter = filterSlashMenu("empiric-test");
      expect(listAfter.some((item) => item.name === "empiric-test-cmd")).toBe(true);

      const found = listAfter.find((item) => item.name === "empiric-test-cmd");
      expect(found?.desc).toBe("Empirical test capability");
      expect(found?.icon).toBe("⚡");

      // Clean up test capability
      capabilityRegistry.unregister("empiric-test-cmd");
    });

    it("handles registered capability without surfaces array without throwing", () => {
      capabilityRegistry.register({
        id: "bad-cap-no-surfaces",
        description: "Malformed capability without surfaces",
        tier: "core",
      } as any);

      // Does not throw TypeError
      const list = filterSlashMenu("");
      expect(Array.isArray(list)).toBe(true);

      // Clean up
      capabilityRegistry.unregister("bad-cap-no-surfaces");
    });

    it("correctly extracts queries from buffer inputs", () => {
      expect(getSlashQuery("/cmd")).toEqual({ query: "cmd" });
      expect(getSlashQuery("/")).toEqual({ query: "" });
      expect(getSlashQuery("/cmd args")).toBeNull();
      expect(getSlashQuery("not a slash")).toBeNull();
    });
  });
});
