export function normalizeWorkerName(agentId: string): string {
  if (agentId.startsWith("worker.")) return agentId;
  return `worker.${agentId.replace(/\s+/g, "-").toLowerCase()}`;
}

export function formatWorkerId(role: string, suffix?: string): string {
  const base = role.replace(/\s+/g, "-").toLowerCase();
  return suffix ? `worker.${base}.${suffix}` : `worker.${base}`;
}
