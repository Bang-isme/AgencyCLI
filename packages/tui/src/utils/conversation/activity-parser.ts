export function isSystemActivityLine(line: string): boolean {
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();
  return (
    // Live markers (current emitters in core/chat/stream.ts + retry path).
    cleanLine.includes("[SYSTEM:") ||
    cleanLine.includes("[SYSTEM WARNING:") ||
    cleanLine.includes("Spawning specialist") ||
    cleanLine.includes("Executing tool") ||
    cleanLine.includes("Retrying in") ||
    // BACK-COMPAT — formats from the per-turn gate-quick verification block +
    // the old "result length" tool summary, removed in `3a22f11`. No longer
    // emitted, but kept so SAVED sessions from before that refactor still
    // collapse correctly. Do NOT delete as "dead" — they detect historical
    // content, not live output.
    cleanLine.includes("completed with result length") ||
    cleanLine.includes("Running auto-verification") ||
    cleanLine.includes("Verification passed successfully") ||
    cleanLine.includes("Verification failed! Re-routing")
  );
}

export function isSubagentNotice(content: string): boolean {
  return (
    /subagent/i.test(content) ||
    /spawned/i.test(content) ||
    /orchestrator/i.test(content) ||
    /reviewer/i.test(content)
  );
}

export function isThinkingOrExploreNotice(content: string): boolean {
  return (
    /thinking/i.test(content) ||
    /thought/i.test(content) ||
    /exploring/i.test(content) ||
    /explore/i.test(content) ||
    /analyzing/i.test(content)
  );
}
