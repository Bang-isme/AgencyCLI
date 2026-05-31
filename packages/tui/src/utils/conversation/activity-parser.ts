export function isSystemActivityLine(line: string): boolean {
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();
  return (
    cleanLine.includes("Spawning specialist") ||
    cleanLine.includes("Executing tool") ||
    cleanLine.includes("completed with result length") ||
    cleanLine.includes("Running auto-verification") ||
    cleanLine.includes("Verification passed successfully") ||
    cleanLine.includes("Verification failed! Re-routing") ||
    cleanLine.includes("[SYSTEM:") ||
    cleanLine.includes("[SYSTEM WARNING:") ||
    cleanLine.includes("Retrying in")
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
