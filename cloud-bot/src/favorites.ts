import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type CloudFavorite = {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  duration?: number;
  savedAt: string;
};

export class FavoriteStore {
  private entries: CloudFavorite[] = [];

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      this.entries = parsed.filter((entry): entry is CloudFavorite => {
        const item = entry as Partial<CloudFavorite>;
        return typeof item.id === "string" && typeof item.title === "string"
          && typeof item.url === "string" && typeof item.savedAt === "string";
      });
    } catch { /* 第一次啟動時檔案尚未存在 */ }
  }

  list(limit = 25): CloudFavorite[] {
    return this.entries.slice(-Math.max(1, limit)).reverse();
  }

  async save(url: string, title?: string): Promise<{ added: boolean; entry: CloudFavorite }> {
    const existing = this.entries.find((entry) => entry.url === url);
    if (existing) return { added: false, entry: existing };
    const entry: CloudFavorite = {
      id: randomUUID(),
      title: title?.trim() || readableTitle(url),
      url,
      savedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    await this.flush();
    return { added: true, entry };
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.entries.slice(-500), null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function readableTitle(value: string): string {
  try {
    const url = new URL(value);
    const id = url.pathname.split("/").filter(Boolean).pop();
    return id ? `${url.hostname} · ${decodeURIComponent(id)}` : url.hostname;
  } catch {
    return value.slice(0, 100);
  }
}
