import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "@agency/providers";

export interface WeightedRoute {
  intent: string;
  suggested_agent: string | null;
  workflow: string;
  skills: string[];
  provider: ProviderId;
  warnings: string[];
}

export interface RoutingFeedbackEntry {
  prompt: string;
  correctIntent: string;
  ts: string;
}

export interface RoutingWeights {
  version: 1;
  signals: Record<string, number>;
  feedback: RoutingFeedbackEntry[];
}

export function weightsPath(projectRoot: string): string {
  return join(projectRoot, ".agency", "routing-weights.json");
}

function defaultWeights(): RoutingWeights {
  return { version: 1, signals: {}, feedback: [] };
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function loadWeights(projectRoot: string): RoutingWeights | null {
  const path = weightsPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RoutingWeights;
    return {
      version: 1,
      signals: raw.signals ?? {},
      feedback: Array.isArray(raw.feedback) ? raw.feedback : [],
    };
  } catch {
    return null;
  }
}

export function saveWeights(projectRoot: string, weights: RoutingWeights): void {
  const dir = join(projectRoot, ".agency");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    weightsPath(projectRoot),
    `${JSON.stringify(weights, null, 2)}\n`,
    "utf8"
  );
}

function rebuildSignals(feedback: RoutingFeedbackEntry[]): Record<string, number> {
  const signals: Record<string, number> = {};
  for (const fb of feedback) {
    for (const token of tokenize(fb.prompt)) {
      const key = `${token}:${fb.correctIntent}`;
      signals[key] = (signals[key] ?? 0) + 1;
    }
  }
  return signals;
}

export function recordFeedback(
  projectRoot: string,
  prompt: string,
  correctIntent: string
): RoutingWeights {
  const weights = loadWeights(projectRoot) ?? defaultWeights();
  weights.feedback.push({
    prompt,
    correctIntent,
    ts: new Date().toISOString(),
  });

  if (weights.feedback.length > 200) {
    weights.feedback = weights.feedback.slice(-200);
  }

  weights.signals = rebuildSignals(weights.feedback);

  saveWeights(projectRoot, weights);
  return weights;
}

/** Sum signal weights for prompt tokens that match signal keys (intent hints). */
export function scoreIntentsFromPrompt(
  prompt: string,
  signals: Record<string, number>
): Record<string, number> {
  const tokens = new Set(tokenize(prompt));
  const scores: Record<string, number> = {};
  for (const [key, weight] of Object.entries(signals)) {
    if (key.includes(":")) {
      const parts = key.split(":");
      if (parts.length === 2) {
        const [token, intent] = parts;
        if (token && intent && tokens.has(token)) {
          scores[intent] = (scores[intent] ?? 0) + weight;
        }
      }
    } else {
      // Fallback for legacy format: key itself is the intent token
      if (tokens.has(key)) {
        scores[key] = (scores[key] ?? 0) + weight;
      }
    }
  }
  return scores;
}

/**
 * Discriminative intent scoring (TF-IDF style).
 *
 * {@link scoreIntentsFromPrompt} sums raw signal counts, so a token that the
 * user happens to type a lot (e.g. "fix", "the", "code") accumulates weight
 * across many intents and can drown out the token that actually distinguishes
 * one intent from another. This variant damps tokens that are spread across
 * many intents (low information) and rewards tokens that point at a single
 * intent (high information):
 *
 *   score(intent) = Σ  weight(token,intent) · (1 + ln(N / df(token)))
 *
 * where `N` is the number of distinct intents seen in the signals and
 * `df(token)` is how many of those intents the token appears under. A fully
 * discriminative token (df = 1) keeps — and is boosted above — its raw weight;
 * a token present under every intent collapses to its raw weight (factor 1),
 * never below it, so learned signal is never discarded.
 */
export function scoreIntentsDiscriminative(
  prompt: string,
  signals: Record<string, number>
): Record<string, number> {
  const tokens = new Set(tokenize(prompt));

  const distinctIntents = new Set<string>();
  const tokenDocFreq = new Map<string, number>();
  for (const key of Object.keys(signals)) {
    const idx = key.indexOf(":");
    if (idx === -1) continue;
    const token = key.slice(0, idx);
    const intent = key.slice(idx + 1);
    if (!token || !intent) continue;
    distinctIntents.add(intent);
    tokenDocFreq.set(token, (tokenDocFreq.get(token) ?? 0) + 1);
  }
  const n = Math.max(distinctIntents.size, 1);

  const scores: Record<string, number> = {};
  for (const [key, weight] of Object.entries(signals)) {
    const idx = key.indexOf(":");
    if (idx === -1) {
      // Legacy format: the key itself is the intent token (no IDF possible).
      if (tokens.has(key)) scores[key] = (scores[key] ?? 0) + weight;
      continue;
    }
    const token = key.slice(0, idx);
    const intent = key.slice(idx + 1);
    if (!token || !intent || !tokens.has(token)) continue;
    const df = tokenDocFreq.get(token) ?? 1;
    const idf = 1 + Math.log(n / df);
    scores[intent] = (scores[intent] ?? 0) + weight * idf;
  }
  return scores;
}

function bestScoredIntent(scores: Record<string, number>): {
  intent: string | null;
  score: number;
} {
  let bestIntent: string | null = null;
  let bestScore = 0;
  for (const [intent, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }
  return { intent: bestIntent, score: bestScore };
}

export function applyWeightsToRoute<T extends WeightedRoute>(
  baseRoute: T,
  prompt: string,
  weights: RoutingWeights
): T {
  const scores = scoreIntentsDiscriminative(prompt, weights.signals);
  const baseIntent = baseRoute.intent;

  // Use a baseline score of 2.0 for the default intent to avoid noise override
  const BASELINE_SCORE = 2.0;
  const baseIntentScore = (scores[baseIntent] ?? 0) + BASELINE_SCORE;

  const { intent: weightedIntent, score: weightedScore } = bestScoredIntent(scores);

  if (
    weightedIntent &&
    weightedIntent !== baseIntent &&
    weightedScore > baseIntentScore
  ) {
    return {
      ...baseRoute,
      intent: weightedIntent,
      warnings: [
        ...baseRoute.warnings,
        `routing-weights: intent adjusted from "${baseIntent}" to "${weightedIntent}" (score ${weightedScore} > base ${baseIntentScore})`,
      ],
    };
  }
  return baseRoute;
}
