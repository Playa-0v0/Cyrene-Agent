import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatEntry, ChatRole } from "./core.js";

const MAX_LOG_BYTES = 8 * 1024 * 1024;

export class MemoryStore {
  private readonly sessions = new Map<string, ChatEntry[]>();
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly maxMessages: number) {
    this.filePath = path.join(dataDir, "discord-history.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    let content = "";
    try { content = await readFile(this.filePath, "utf8"); } catch { return; }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as ChatEntry;
        if (!item.sessionId || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") continue;
        this.pushMemory(item);
      } catch { /* 忽略不完整的最後一行 */ }
    }
  }

  get(sessionId: string): ChatEntry[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async append(sessionId: string, role: ChatRole, content: string): Promise<void> {
    const item: ChatEntry = { sessionId, role, content, at: Date.now() };
    this.pushMemory(item);
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(this.filePath, `${JSON.stringify(item)}\n`, { encoding: "utf8", mode: 0o600 });
      await this.compactIfNeeded();
    });
    await this.writeChain;
  }

  async forget(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.writeChain = this.writeChain.then(() => this.rewrite());
    await this.writeChain;
  }

  private pushMemory(item: ChatEntry): void {
    const entries = this.sessions.get(item.sessionId) ?? [];
    entries.push(item);
    this.sessions.set(item.sessionId, entries.slice(-this.maxMessages));
  }

  private async compactIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.filePath)).size > MAX_LOG_BYTES) await this.rewrite();
    } catch { /* 下次寫入再試 */ }
  }

  private async rewrite(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    const lines = [...this.sessions.values()].flat().sort((a, b) => a.at - b.at).map((item) => JSON.stringify(item));
    await writeFile(tempPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}
