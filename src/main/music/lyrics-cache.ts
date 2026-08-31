// Parsed-lyric disk cache, keyed by encrypted song id. Persists "no lyrics"
// as an empty array too, so quota is never spent twice on the same song.
//
// 格式 v2：`{ version: 2, lines }`（lines 带 translation 字段）。
// v1 是裸数组（无翻译）——读取时视为 miss，重新拉 API 升级为 v2。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LyricLine } from "./lyrics-parser";

const ID_RE = /^[0-9A-Fa-f]{32}$/; // also guards path traversal
const FORMAT_VERSION = 2;

interface CacheFile {
  version: number;
  lines: LyricLine[];
}

export class LyricsCache {
  constructor(private readonly cacheDir: string) {}

  private fileFor(encryptedId: string): string {
    return path.join(this.cacheDir, `${encryptedId.toLowerCase()}.json`);
  }

  /** null = cache miss（含 v1 旧格式）；[] = cached "no lyrics". */
  async get(encryptedId: string): Promise<LyricLine[] | null> {
    if (!ID_RE.test(encryptedId)) return null;
    try {
      const raw = await fs.readFile(this.fileFor(encryptedId), "utf8");
      const parsed = JSON.parse(raw) as CacheFile | LyricLine[];
      // v1 裸数组 → miss，重拉（换取翻译字段）
      if (!Array.isArray(parsed)) {
        if (parsed?.version !== FORMAT_VERSION || !Array.isArray(parsed.lines)) {
          return null;
        }
        const lines = parsed.lines;
        return lines.filter(
          (l) => l && typeof l.timeMs === "number" && typeof l.text === "string",
        );
      }
      return null;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null; // corrupt entry = miss; next get() rewrites it
    }
  }

  async set(encryptedId: string, lines: LyricLine[]): Promise<void> {
    if (!ID_RE.test(encryptedId)) return;
    await fs.mkdir(this.cacheDir, { recursive: true });
    const file = this.fileFor(encryptedId);
    const tmp = file + ".tmp";
    const payload: CacheFile = { version: FORMAT_VERSION, lines };
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.cacheDir, { recursive: true, force: true });
  }
}
