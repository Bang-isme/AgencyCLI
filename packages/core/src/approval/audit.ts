import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  action: string;
  tool?: string;
  command?: string;
  approved: boolean;
}

export function appendAudit(projectRoot: string, entry: AuditEntry): void {
  const agencyDir = join(projectRoot, ".agency");
  mkdirSync(agencyDir, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    user: process.env.USER ?? process.env.USERNAME ?? "unknown",
    ...entry,
  };
  appendFileSync(
    join(agencyDir, "audit.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
}
