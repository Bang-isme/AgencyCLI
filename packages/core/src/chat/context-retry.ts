import { getBaselineModelSpec } from "@agency/providers";

/** Session-scoped trim targets — never persisted to ~/.agency/config.json. */
const sessionContextLimits = new Map<string, number>();

function sessionKey(sessionId: string, modelName: string, providerId?: string): string {
  return `${sessionId}:${modelIdKey(modelName, providerId)}`;
}

function modelIdKey(modelName: string, providerId?: string): string {
  return `${providerId ?? "default"}:${modelName}`;
}

/** Catalog context window (ignores persisted overrides for retry trim). */
export function getCatalogContextWindow(modelName: string, providerId?: string): number {
  return getBaselineModelSpec(modelName, providerId).contextWindow;
}

export function getSessionContextLimit(
  sessionId: string,
  modelName: string,
  providerId?: string
): number | undefined {
  return sessionContextLimits.get(sessionKey(sessionId, modelName, providerId));
}

export function setSessionContextLimit(
  sessionId: string,
  modelName: string,
  providerId: string | undefined,
  limit: number
): void {
  sessionContextLimits.set(sessionKey(sessionId, modelName, providerId), limit);
}

export function clearSessionContextLimits(sessionId?: string): void {
  if (!sessionId) {
    sessionContextLimits.clear();
    return;
  }
  for (const key of sessionContextLimits.keys()) {
    if (key.startsWith(`${sessionId}:`)) sessionContextLimits.delete(key);
  }
}

/**
 * Resolve the limit to trim toward on context-overflow retry.
 * Never ratchets catalog spec down — uses provider-parsed limit when available,
 * otherwise keeps the catalog window and relies on history reduction.
 */
export function resolveContextRetryLimit(
  sessionId: string,
  modelName: string,
  providerId: string | undefined,
  parsedFromError: number | null
): number {
  const catalog = getCatalogContextWindow(modelName, providerId);
  if (parsedFromError && parsedFromError > 8192 && parsedFromError < catalog) {
    setSessionContextLimit(sessionId, modelName, providerId, parsedFromError);
    return parsedFromError;
  }
  return getSessionContextLimit(sessionId, modelName, providerId) ?? catalog;
}

/** Effective input budget after safety margin and reserved output tokens. */
export function computeEffectiveContextBudget(
  contextWindow: number,
  maxOutputTokens: number,
  marginRatio = 0.1
): number {
  const margin = Math.round(contextWindow * marginRatio);
  return Math.max(2000, contextWindow - margin - maxOutputTokens);
}
