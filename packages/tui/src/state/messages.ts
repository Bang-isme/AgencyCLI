import type { RouteChip } from "@agency/core";

export type MessageRole = "user" | "assistant" | "system";

export interface MessagePresentation {
  chips: RouteChip[];
  suggestions?: string[];
  cacheHint?: string;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** @deprecated Prefer presentation.chips — kept for legacy sessions */
  routeSummary?: string;
  presentation?: MessagePresentation;
  /** Live LLM token stream in progress. */
  streaming?: boolean;
  thought?: string;
  timestamp: number;
}

export function newMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
