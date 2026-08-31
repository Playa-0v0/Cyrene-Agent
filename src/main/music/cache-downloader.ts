// CacheDownloader — 边播边存：播放 CDN 流的同时并行下载同一 URL 到本地缓存池。
//
// 工程不变量（review 后固定，勿破坏）：
//   1. 缓存命中 = index.has(id) && exists(filePath) 双条件——用户手动删文件不会"假命中"
//   2. inFlight 用 Promise 复用（Map<string, Promise<CacheResult>>）：
//      并发的第二处调用拿到同一个 Promise，而不是被拒绝；service 层
//      "未缓存但下载中"时 await 该 Promise 直接播本地，杜绝重复打 API
//   3. 内存 Map 是唯一当前状态，所有索引 mutation 串行执行（promise 队列）；
//      持久化走 index.json.tmp → rename 原子替换，崩溃也不会写半截
//   4. 启动 reconcile 双向对账：索引有但文件丢 → 移除记录；文件有但索引缺 → 清孤儿
//
// 下载为 fire-and-forget：中途切歌不取消（已下完的照常收录，不浪费流量）。
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EventEmitter } from "node:events";
import type { MusicTrack } from "./types";

export interface CachedTrackRecord {
  encryptedId: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  size: number;
  cachedAt: number;
  source: "netease" | "imported";
  /** 缓存池内的文件名（`<id>.mp3` 或 `local-<hash>.<ext>`）。 */
  fileName: string;
}

export interface CacheResult {
  ok: boolean;
  trackId: string;
  filePath?: string;
  errorCode?: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac"]);
const INDEX_FILE = "index.json";

/**
 * music-metadata 是 ESM-only 包，而主进程是 CJS 编译产物；
 * 原生 dynamic import（不经 TS 的 require 转换）在任何现代 Node 上都可用。
 */
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<typeof import("music-metadata")>;

export class CacheDownloader extends EventEmitter {
  private index = new Map<string, CachedTrackRecord>();
  private inFlight = new Map<string, Promise<CacheResult>>();
  /** 索引 mutation 串行队列：所有写操作链在这条 Promise 链上。 */
  private opQueue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private readonly cacheDir: string;
  private readonly indexPath: string;
  private readonly indexTmpPath: string;

  constructor(cacheDir: string) {
    super();
    this.cacheDir = cacheDir;
    this.indexPath = path.join(cacheDir, INDEX_FILE);
    this.indexTmpPath = path.join(cacheDir, `${INDEX_FILE}.tmp`);
  }

  /** 幂等初始化：建目录 + 读索引 + 对账。失败不抛（缓存是可选能力）。 */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      await this.loadIndex();
      await this.reconcile();
    } catch (err) {
      console.warn("[music-cache] initialize failed:", err instanceof Error ? err.message : err);
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.indexPath, "utf8");
      const arr = JSON.parse(raw) as CachedTrackRecord[];
      if (Array.isArray(arr)) {
        for (const rec of arr) {
          if (rec && typeof rec.encryptedId === "string" && typeof rec.fileName === "string") {
            this.index.set(rec.encryptedId, rec);
          }
        }
      }
    } catch {
      /* 索引不存在或损坏 → 以空索引重建 */
    }
  }

  /** 所有索引 mutation 串行执行；返回值透传 fn 的结果。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(fn, fn);
    this.opQueue = run.catch(() => {});
    return run;
  }

  /** 原子持久化索引（仅在串行队列内调用）。 */
  private async persistIndexLocked(): Promise<void> {
    const arr = [...this.index.values()];
    await fsp.writeFile(this.indexTmpPath, JSON.stringify(arr, null, 2), "utf8");
    await fsp.rename(this.indexTmpPath, this.indexPath);
  }

  private emitUpdated(): void {
    this.emit("updated");
  }

  // ── 查询 ────────────────────────────────────────────────────

  /** 双条件命中：索引有记录 && 文件真实存在。 */
  isCached(id: string): boolean {
    return this.getFilePath(id) !== undefined;
  }

  getFilePath(id: string): string | undefined {
    const rec = this.index.get(id);
    if (!rec) return undefined;
    const p = path.join(this.cacheDir, rec.fileName);
    try {
      return fs.existsSync(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }

  /** 正在下载的任务（Promise 复用入口）。 */
  getDownloadPromise(id: string): Promise<CacheResult> | undefined {
    return this.inFlight.get(id);
  }

  getTrack(id: string): CachedTrackRecord | undefined {
    return this.index.get(id);
  }

  listTracks(): MusicTrack[] {
    return [...this.index.values()]
      .sort((a, b) => a.cachedAt - b.cachedAt)
      .map((rec) => ({
        id: rec.encryptedId,
        encryptedId: rec.encryptedId,
        name: rec.name,
        artists: rec.artists,
        album: rec.album,
        durationMs: rec.durationMs,
        coverUrl: rec.coverUrl,
        source: rec.source,
      }));
  }

  // ── 下载（边播边存） ────────────────────────────────────────

  /**
   * 下载到缓存池。已缓存 → 跳过；下载中 → 复用现有 Promise；
   * 否则启动新下载。切歌不取消（fire-and-forget 由调用方决定）。
   */
  download(track: MusicTrack, playUrl: string): Promise<CacheResult> {
    const id = track.id;
    if (this.isCached(id)) {
      console.log("[music-cache] skip (already cached):", { trackId: id, name: track.name });
      return Promise.resolve({ ok: true, trackId: id, filePath: this.getFilePath(id) });
    }
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const task = this.runDownload(track, playUrl).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, task);
    return task;
  }

  private async runDownload(track: MusicTrack, playUrl: string): Promise<CacheResult> {
    const id = track.id;
    const fileName = `${id}.mp3`;
    const partPath = path.join(this.cacheDir, `${fileName}.part`);
    const finalPath = path.join(this.cacheDir, fileName);
    console.log("[music-cache] download start:", { trackId: id, name: track.name, urlLen: playUrl.length });
    try {
      const res = await fetch(playUrl);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const expected = Number(res.headers.get("content-length")) || 0;
      await fsp.mkdir(this.cacheDir, { recursive: true });
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(partPath));
      const stat = await fsp.stat(partPath);
      // CDN 给了 Content-Length 时严格比对；没给则信任正常 end
      if (expected > 0 && stat.size !== expected) {
        throw new Error(`size mismatch: ${stat.size}/${expected}`);
      }
      await fsp.rename(partPath, finalPath);
      const size = stat.size;
      await this.enqueue(async () => {
        this.index.set(id, {
          encryptedId: id,
          name: track.name,
          artists: track.artists,
          album: track.album,
          durationMs: track.durationMs,
          coverUrl: track.coverUrl,
          size,
          cachedAt: Date.now(),
          source: "netease",
          fileName,
        });
        await this.persistIndexLocked();
      });
      this.emitUpdated();
      console.log("[music-cache] cached:", { trackId: id, name: track.name, size, path: finalPath });
      return { ok: true, trackId: id, filePath: finalPath };
    } catch (err) {
      await fsp.rm(partPath, { force: true }).catch(() => { /* ignore */ });
      console.warn("[music-cache] download failed:", {
        trackId: id,
        name: track.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, trackId: id, errorCode: "E_CACHE_DOWNLOAD_FAILED" };
    }
  }

  // ── 删除 ────────────────────────────────────────────────────

  /** 删除缓存文件 + 索引记录。返回是否真的删了（不存在则 false）。 */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.enqueue(async () => {
      const rec = this.index.get(id);
      if (!rec) return;
      await fsp.rm(path.join(this.cacheDir, rec.fileName), { force: true }).catch(() => { /* ignore */ });
      this.index.delete(id);
      removed = true;
      await this.persistIndexLocked();
    });
    if (removed) this.emitUpdated();
    return removed;
  }

  // ── 导入用户本地音乐 ────────────────────────────────────────

  /**
   * 导入本地音频文件：复制进缓存池，id 用 `local-<内容hash>`（同内容重复导入自动去重），
   * 导入时即解析元数据（解析不到回退文件名）。
   */
  async importFiles(filePaths: string[]): Promise<ImportResult> {
    let imported = 0;
    let skipped = 0;
    for (const src of filePaths) {
      const ext = path.extname(src).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) {
        skipped++;
        continue;
      }
      try {
        const buf = await fsp.readFile(src);
        const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
        const id = `local-${hash}`;
        if (this.index.has(id)) {
          skipped++;
          console.log("[music-cache] skip (already imported):", { trackId: id, file: path.basename(src) });
          continue;
        }
        const fileName = `${id}${ext}`;
        const dest = path.join(this.cacheDir, fileName);
        if (!fs.existsSync(dest)) await fsp.writeFile(dest, buf);

        const { name, artists, album, durationMs } = await this.parseMetadata(dest, src);
        const stat = await fsp.stat(dest);
        await this.enqueue(async () => {
          this.index.set(id, {
            encryptedId: id,
            name,
            artists,
            album,
            durationMs,
            size: stat.size,
            cachedAt: Date.now(),
            source: "imported",
            fileName,
          });
          await this.persistIndexLocked();
        });
        imported++;
        console.log("[music-cache] imported:", { trackId: id, name, size: stat.size });
      } catch (err) {
        skipped++;
        console.warn("[music-cache] import failed:", {
          file: src,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (imported > 0) this.emitUpdated();
    return { imported, skipped };
  }

  private async parseMetadata(
    filePath: string,
    srcPath: string,
  ): Promise<{ name: string; artists: string[]; album?: string; durationMs?: number }> {
    const fallbackName = path.basename(srcPath, path.extname(srcPath));
    try {
      const mm = await nativeImport("music-metadata");
      const meta = await mm.parseFile(filePath);
      const artists =
        meta.common.artists?.filter(Boolean)
        ?? (meta.common.artist
          ? meta.common.artist.split(/[,/、]/).map((s) => s.trim()).filter(Boolean)
          : []);
      return {
        name: meta.common.title?.trim() || fallbackName,
        artists,
        album: meta.common.album || undefined,
        durationMs:
          typeof meta.format.duration === "number"
            ? Math.round(meta.format.duration * 1000)
            : undefined,
      };
    } catch {
      // 元数据解析失败 → 回退文件名，其余留空
      return { name: fallbackName, artists: [] };
    }
  }

  // ── 启动对账 ────────────────────────────────────────────────

  /**
   * 索引 ↔ 文件双向对账：
   *   - 清理孤儿 .part（上次下载中断）
   *   - 索引有记录但文件被手动删 → 移除记录（保证 isCached 永不假命中）
   *   - 文件存在但索引没有（崩溃前索引没写完）→ 清除孤儿文件（元数据无法恢复）
   */
  async reconcile(): Promise<void> {
    let changed = false;
    await this.enqueue(async () => {
      const entries = await fsp.readdir(this.cacheDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".part")) {
          await fsp.rm(path.join(this.cacheDir, e.name), { force: true });
          changed = true;
        }
      }
      for (const [id, rec] of [...this.index]) {
        try {
          await fsp.access(path.join(this.cacheDir, rec.fileName));
        } catch {
          this.index.delete(id);
          changed = true;
        }
      }
      const known = new Set([...this.index.values()].map((r) => r.fileName));
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (e.name === INDEX_FILE || e.name.endsWith(".part")) continue;
        if (!known.has(e.name) && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
          await fsp.rm(path.join(this.cacheDir, e.name), { force: true });
          changed = true;
        }
      }
      if (changed) await this.persistIndexLocked();
    });
    if (changed) this.emitUpdated();
  }

  onUpdated(listener: () => void): () => void {
    this.on("updated", listener);
    return () => this.off("updated", listener);
  }
}
