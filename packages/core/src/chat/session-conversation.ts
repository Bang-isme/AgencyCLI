import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatMessage } from "./orchestrator.js";
import { estimateMessagesTokens } from "@agency/providers";

export class SessionConversationManager {
  private sessionDir: string;
  private sessionPath: string;

  constructor(projectRoot: string, sessionId: string) {
    this.sessionDir = join(projectRoot, ".agency", "sessions");
    this.sessionPath = join(this.sessionDir, `${sessionId}.jsonl`);
  }

  public getSessionPath(): string {
    return this.sessionPath;
  }

  /**
   * Appends a single ChatMessage to the append-only JSONL session file.
   */
  public appendMessage(message: ChatMessage): void {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    const line = JSON.stringify(message) + "\n";
    appendFileSync(this.sessionPath, line, "utf8");
  }

  /**
   * Loads the dialogue history from the append-only JSONL session file.
   */
  public loadHistory(): ChatMessage[] {
    if (!existsSync(this.sessionPath)) {
      return [];
    }
    try {
      const content = readFileSync(this.sessionPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      return lines.map((line) => JSON.parse(line) as ChatMessage);
    } catch {
      return [];
    }
  }

  /**
   * Rewrites the JSONL session file cleanly with the compact history state.
   */
  public checkpointConversation(history: ChatMessage[]): void {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    const content = history.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
    writeFileSync(this.sessionPath, content, "utf8");
  }

  /**
   * Summarizes the dialogue history dynamically if it exceeds 70% of the context limit.
   * Keeps the original system prompt and the last 4 turns intact in full.
   */
  public async summarizeHistory(
    history: ChatMessage[],
    provider: any,
    contextWindowLimit: number
  ): Promise<ChatMessage[]> {
    const tokenCount = estimateMessagesTokens(history);
    const threshold = Math.round(contextWindowLimit * 0.7);

    // Only summarize if exceeding 70% of the active context window limit
    if (tokenCount <= threshold || history.length <= 6) {
      return history;
    }

    const firstTurn = history[0];
    const systemTurn = firstTurn && firstTurn.role === "system" ? firstTurn : null;
    const startIndex = systemTurn ? 1 : 0;

    const last4Turns = history.slice(-4);
    const middleTurns = history.slice(startIndex, -4);

    if (middleTurns.length === 0) {
      return history;
    }

    let summaryText = "";
    if (provider && typeof provider.complete === "function") {
      try {
        const payload =
          "Summarize the following developer interaction history cleanly, extremely briefly, highlighting key findings, active tasks, and context. Do not output anything else:\n\n" +
          middleTurns.map((m) => `[${m.role}]: ${m.content}`).join("\n");

        const res = await provider.complete({
          messages: [{ role: "user", content: payload }],
          max_tokens: 300,
        });
        summaryText = res?.text?.trim() || "";
      } catch {
        // Fallback below on catch
      }
    }

    if (!summaryText) {
      // Fallback: character-level truncation summary
      const totalTruncated = middleTurns.length;
      summaryText = `[Dialogue history compressed: truncated ${totalTruncated} middle turns to save memory context]`;
    }

    const summaryTurn: ChatMessage = {
      role: "system",
      content: `[SYSTEM HISTORICAL CONVERSATION SUMMARY]: ${summaryText}`,
    };

    const newHistory: ChatMessage[] = [];
    if (systemTurn) {
      newHistory.push(systemTurn);
    }
    newHistory.push(summaryTurn);
    newHistory.push(...last4Turns);

    // Save checkpoint cleanly
    this.checkpointConversation(newHistory);

    return newHistory;
  }
}
