import type { ActionLifecycleEvent, ActionLifecycleState } from "@agency/core";
import type { ThemeTokens } from "../themes/registry.js";
import { SPINNER_DOTS, LIFECYCLE_GLYPHS } from "../motion/design-system.js";

export interface CompactRowViewModel {
  id: string;
  glyph: string;
  glyphColor: keyof ThemeTokens;
  label: string;
  sublabel?: string;
  badge?: { text: string; bg?: keyof ThemeTokens; fg?: keyof ThemeTokens };
  metaText?: string;
  status: ActionLifecycleState;
}

export interface ExpandedDetailViewModel {
  id: string;
  title: string;
  summary?: string;
  rawDetail?: string;
  startedAt?: number;
  durationMs?: number;
  formattedDuration?: string;
  agentId?: string;
  dispatchId?: string;
  hasError: boolean;
  codeBlock?: { language: string; content: string };
}

export interface KeyShortcut {
  key: string;
  label: string;
  action: "retry" | "expand" | "resume" | "reset" | "dismiss";
}

export interface RecoveryCTAViewModel {
  hasRecovery: boolean;
  recoveryMessage?: string;
  defaultAction?: string;
  keyShortcuts: KeyShortcut[];
}

export interface FullPresentationViewModel {
  compact: CompactRowViewModel;
  expanded: ExpandedDetailViewModel;
  recovery: RecoveryCTAViewModel;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export class PresentationMapper {
  /**
   * Maps an ActionLifecycleEvent into a CompactRowViewModel for timeline, rails, and activity lines.
   */
  public static mapToCompactRow(
    event: ActionLifecycleEvent,
    _theme: ThemeTokens,
    options?: { active?: boolean; tick?: number }
  ): CompactRowViewModel {
    const tick = options?.tick ?? 0;

    let glyph = "·";
    let glyphColor: keyof ThemeTokens = "muted";

    switch (event.state) {
      case "running":
        glyph = SPINNER_DOTS[tick % SPINNER_DOTS.length] ?? "▶";
        glyphColor = "accent";
        break;
      case "succeeded":
        glyph = LIFECYCLE_GLYPHS.done ?? "✓";
        glyphColor = "success";
        break;
      case "failed":
        glyph = "✕";
        glyphColor = "danger";
        break;
      case "incomplete":
        glyph = "⏸";
        glyphColor = "warning";
        break;
      case "cancelled":
        glyph = "○";
        glyphColor = "muted";
        break;
      case "queued":
        glyph = LIFECYCLE_GLYPHS.pending ?? "◇";
        glyphColor = "muted";
        break;
    }

    const label = event.semantic?.label || event.label;
    const sublabel = event.target || (event.agentId && event.agentId !== "main" ? `worker.${event.agentId}` : undefined);
    const durationStr = formatDuration(event.durationMs ?? event.elapsedMs);

    return {
      id: event.id,
      glyph,
      glyphColor,
      label,
      sublabel,
      metaText: [event.summary, durationStr].filter(Boolean).join(" · "),
      status: event.state,
    };
  }

  /**
   * Maps an ActionLifecycleEvent into an ExpandedDetailViewModel for expanded timeline cards.
   */
  public static mapToExpandedDetail(
    event: ActionLifecycleEvent,
    _theme: ThemeTokens
  ): ExpandedDetailViewModel {
    const rawDetailVal = typeof event.rawDetail === "string"
      ? event.rawDetail
      : event.rawDetail?.summary !== undefined
        ? event.rawDetail.summary
        : event.rawDetail;

    const rawDetailStr = rawDetailVal !== undefined && rawDetailVal !== null
      ? (typeof rawDetailVal === "string" ? rawDetailVal : String(rawDetailVal))
      : undefined;

    const hasError = event.state === "failed" || event.state === "incomplete" || event.verificationState?.status === "verification_failed";
    const durationMs = event.durationMs ?? event.elapsedMs;

    let codeBlock: { language: string; content: string } | undefined = undefined;
    const safeDetailStr = String(rawDetailStr || "");
    if (rawDetailStr && (safeDetailStr.includes("\n") || safeDetailStr.length > 80)) {
      codeBlock = {
        language: event.semantic?.category === "exec" ? "bash" : "json",
        content: rawDetailStr,
      };
    }

    return {
      id: event.id,
      title: event.label,
      summary: event.summary,
      rawDetail: rawDetailStr,
      startedAt: event.startedAt,
      durationMs,
      formattedDuration: formatDuration(durationMs),
      agentId: event.agentId,
      dispatchId: event.dispatchId,
      hasError,
      codeBlock,
    };
  }

  /**
   * Maps an ActionLifecycleEvent into a RecoveryCTAViewModel for interactive recovery prompts.
   */
  public static mapToRecoveryCTA(event: ActionLifecycleEvent): RecoveryCTAViewModel {
    const recoveryMsg = event.recoveryHint?.suggestion || event.recovery;
    const hasRecovery = Boolean(recoveryMsg) || event.state === "failed" || event.state === "incomplete";

    const keyShortcuts: KeyShortcut[] = [];
    if (hasRecovery) {
      keyShortcuts.push({ key: "r", label: "Retry action", action: "retry" });
      keyShortcuts.push({ key: "e", label: "Inspect details", action: "expand" });
      keyShortcuts.push({ key: "c", label: "Continue session", action: "resume" });
    }

    return {
      hasRecovery,
      recoveryMessage: recoveryMsg,
      defaultAction: event.recoveryHint?.suggestedAction ?? (hasRecovery ? "retry" : undefined),
      keyShortcuts,
    };
  }

  /**
   * Combines compact, expanded, and recovery views for full presentation rendering.
   */
  public static mapToFullPresentation(
    event: ActionLifecycleEvent,
    theme: ThemeTokens,
    options?: { active?: boolean; tick?: number }
  ): FullPresentationViewModel {
    return {
      compact: PresentationMapper.mapToCompactRow(event, theme, options),
      expanded: PresentationMapper.mapToExpandedDetail(event, theme),
      recovery: PresentationMapper.mapToRecoveryCTA(event),
    };
  }
}
