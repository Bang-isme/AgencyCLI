import type { ProviderId } from "@agency/providers";
import type { RouteResult } from "./model-router.js";

/**
 * Built-in, dependency-free routing heuristic used when the Python
 * `prompt_router.py` is unavailable (Python not installed, script error, …).
 *
 * It mirrors the intent/workflow/agent vocabulary of the canonical router
 * (see `.system/references/prompt-router.corpus.json`) with keyword rules so
 * the CLI keeps working — degraded but functional — without Python. Order
 * matters: the first matching rule wins, so the most specific intents
 * (security review, debugging) are checked before generic build/plan intents.
 */
interface IntentRule {
  intent: string;
  workflow: string;
  suggested_agent: string | null;
  skills: string[];
  keywords: RegExp;
}

const RULES: IntentRule[] = [
  {
    intent: "review",
    workflow: "review",
    suggested_agent: "security-auditor",
    skills: ["codex-security-specialist"],
    keywords:
      /(security|vulnerabilit|exploit|\bcve\b|\baudit\b|pentest|lỗ hổng|bảo mật|deploy to prod|production deploy)/i,
  },
  {
    intent: "debug",
    workflow: "debug",
    suggested_agent: "debugger",
    skills: ["codex-systematic-debugging"],
    keywords:
      /(\bfix\b|\bbug\b|debug|\berror\b|traceback|stack ?trace|crash|fails?\b|failing|broken|exception|lỗi|sửa lỗi)/i,
  },
  {
    intent: "docs",
    workflow: "handoff",
    suggested_agent: "planner",
    skills: ["codex-document-writer"],
    keywords: /(\bdocs?\b|documentation|readme|handoff|tài liệu|changelog)/i,
  },
  {
    intent: "build",
    workflow: "create",
    suggested_agent: "frontend-specialist",
    skills: ["codex-test-driven-development"],
    keywords:
      /(react|vue|svelte|frontend|front-end|\bui\b|\bcss\b|component|dashboard|giao diện)/i,
  },
  {
    intent: "build",
    workflow: "create",
    suggested_agent: "backend-specialist",
    skills: ["codex-test-driven-development"],
    keywords:
      /(backend|back-end|\bapi\b|endpoint|server|database|\bdb\b|\bsql\b|migration|service)/i,
  },
  {
    intent: "build",
    workflow: "create",
    suggested_agent: "backend-specialist",
    skills: ["codex-test-driven-development"],
    keywords: /(\bbuild\b|implement|create|\badd\b|develop|feature|làm|tạo|xây dựng)/i,
  },
  {
    intent: "other",
    workflow: "plan",
    suggested_agent: "planner",
    skills: ["codex-plan-writer"],
    keywords:
      /(\bplan\b|design|architect|architecture|brainstorm|\bspec\b|kiến trúc|thiết kế|lên kế hoạch)/i,
  },
];

/**
 * Classify a prompt into a {@link RouteResult} using keyword heuristics.
 * Always returns a valid route (defaults to the neutral `other`/`create`
 * route for empty or unrecognized prompts). `warnings` is left empty here;
 * the caller annotates why the fallback was taken.
 */
export function heuristicRoute(prompt: string, provider: ProviderId): RouteResult {
  const text = (prompt ?? "").trim();
  if (text) {
    for (const rule of RULES) {
      if (rule.keywords.test(text)) {
        return {
          intent: rule.intent,
          suggested_agent: rule.suggested_agent,
          workflow: rule.workflow,
          skills: rule.skills,
          provider,
          warnings: [],
        };
      }
    }
  }
  return {
    intent: "other",
    suggested_agent: null,
    workflow: "create",
    skills: [],
    provider,
    warnings: [],
  };
}
