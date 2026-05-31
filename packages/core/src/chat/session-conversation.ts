import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatMessage } from "./orchestrator.js";
import { compactTurnHistory } from "./turn-helpers.js";

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
   * Summarizes the dialogue history dynamically if it exceeds 70% of the context
   * limit, keeping the original system prompt and the last 4 turns intact, then
   * persists the compacted history to the session file.
   *
   * Delegates the actual compaction to the shared {@link compactTurnHistory} so
   * there is exactly ONE compaction algorithm (the live turn path uses the same
   * one). `provider` must expose the real `complete(messages, opts): Promise<string>`
   * API; an unusable provider falls back to a placeholder summary.
   */
  public async summarizeHistory(
    history: ChatMessage[],
    provider: any,
    contextWindowLimit: number
  ): Promise<ChatMessage[]> {
    const { messages, compacted } = await compactTurnHistory(
      history,
      provider,
      contextWindowLimit
    );
    if (compacted) {
      this.checkpointConversation(messages);
    }
    return messages;
  }
}
