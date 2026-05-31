import type { SessionMessage } from "../state/messages.js";
import { formatSystemNotice } from "../components/SystemNotice.js";

const HELP_MARKERS = [
  "Slash commands:",
  "Shortcuts:",
  "Ctrl+P palette",
  "/doctor",
  "/connect",
  "agency config init",
];

function isHelpDump(content: string): boolean {
  const hits = HELP_MARKERS.filter((m) => content.includes(m)).length;
  return hits >= 2 || (content.includes("Slash commands:") && content.length > 80);
}

/** Drop legacy help spam; compact noisy system lines when loading sessions. */
export function sanitizeSessionMessages(
  messages: SessionMessage[]
): SessionMessage[] {
  return messages
    .filter((m) => {
      if (m.role !== "system") return true;
      if (isHelpDump(m.content)) return false;
      return true;
    })
    .map((m) => {
      if (m.role !== "system") return m;
      const compact = formatSystemNotice(m.content);
      if (compact === m.content) return m;
      return { ...m, content: compact };
    });
}
