import { SessionService } from "@agency/core";
import type { SessionMessage } from "../state/messages.js";

export interface AgencySession {
  id: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
}

export interface SessionSummary {
  id: string;
  messageCount: number;
  updatedAt: number;
  firstUserMessage?: string;
}

export function sessionsDir(projectRoot: string): string {
  return SessionService.sessionsDir(projectRoot);
}

export function sessionPath(projectRoot: string, id: string): string {
  return SessionService.sessionPath(projectRoot, id);
}

export function createSession(projectRoot: string): AgencySession {
  return SessionService.createSession(projectRoot) as unknown as AgencySession;
}

export function forkSession(
  source: AgencySession,
  upToMessageId: string
): AgencySession {
  return SessionService.forkSession(source as any, upToMessageId) as unknown as AgencySession;
}

export function saveSession(session: AgencySession): void {
  SessionService.saveSession(session as any);
}

export function deleteSession(projectRoot: string, id: string): void {
  SessionService.deleteSession(projectRoot, id);
}

export function loadSession(
  projectRoot: string,
  id: string
): AgencySession | null {
  return SessionService.loadSession(projectRoot, id) as unknown as AgencySession | null;
}

export function listSessionIds(projectRoot: string): string[] {
  return SessionService.listSessionIds(projectRoot);
}

export function listSessionSummaries(projectRoot: string): SessionSummary[] {
  return SessionService.listSessionSummaries(projectRoot) as unknown as SessionSummary[];
}

export function exportSessionMarkdown(session: AgencySession): string {
  return SessionService.exportSessionMarkdown(session as any);
}

export function exportSessionToFile(session: AgencySession): string {
  return SessionService.exportSessionToFile(session as any);
}

export function loadLatestSession(projectRoot: string): AgencySession {
  return SessionService.loadLatestSession(projectRoot) as unknown as AgencySession;
}
