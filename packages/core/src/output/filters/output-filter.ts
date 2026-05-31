const AI_THEATER: Array<[RegExp, string]> = [
  [/\bI think\b\s*/gi, ""],
  [/\bI understand\b\s*/gi, ""],
  [/\bLet me\b\s*/gi, ""],
  [/\bI'll\b\s*/gi, ""],
  [/\bI believe\b\s*/gi, ""],
  [/\bHere's what I found\b\s*/gi, ""],
  [/\bI have successfully\b\s*/gi, ""],
  [/\bI'm going to\b\s*/gi, ""],
  [/\bI'll analyze\b\s*/gi, ""],
  [/\bI'll spawn\b\s*/gi, ""],
];

const CONVERSATIONAL: Array<[RegExp, string]> = [
  [/^Next:\s*\n?/gm, ""],
  [/\bUse --force to overwrite\.?\s*/gi, ""],
  [/\bSet API keys or.*?then:\s*/gi, ""],
];

export function stripAiTheater(text: string): string {
  let result = text;
  for (const [pattern, replacement] of AI_THEATER) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function stripConversational(text: string): string {
  let result = text;
  for (const [pattern, replacement] of CONVERSATIONAL) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function stripEnthusiasm(text: string): string {
  return text
    .replace(/ successfully!/g, ".")
    .replace(/ completed!/g, ".")
    .replace(/ done!/g, ".")
    .replace(/!$/gm, ".");
}

export function normalizeWarningPrefix(text: string): string {
  return text.replace(/^Warning:\s*/gm, "[warn] ");
}

export function stripCoachingHints(text: string): string {
  return text
    .replace(/^Next:\s*$/gm, "")
    .replace(/^Recommended:\s*$/gm, "");
}

export function stripNarration(text: string): string {
  return text
    .replace(/^Running\s+(\w[\w\s]*?)\.\.\.\s*$/gm, "⟐ $1")
    .replace(/^Attempting\s+(\w[\w\s]*?)\.\.\.\s*$/gm, "⟐ $1");
}

export function applyOutputFilter(text: string): string {
  if (!text.trim()) return text;
  let result = text;
  result = stripAiTheater(result);
  result = stripConversational(result);
  result = stripEnthusiasm(result);
  result = normalizeWarningPrefix(result);
  result = stripCoachingHints(result);
  result = stripNarration(result);
  result = result.replace(/\n{3,}/g, "\n\n");
  return result;
}
