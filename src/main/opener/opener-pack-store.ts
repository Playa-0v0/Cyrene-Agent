// 掃描 manifest.json + 選文案 + 查 wav 存在性 + 讀 wav 頭算 durationMs
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { Manifest, ManifestItem } from "./opener-types";
import { BUILT_IN_TEXT_MANIFEST } from "./default-pack";

export function getOpenerPackDir(): string {
  return path.join(app.getPath("userData"), "cyrene-opener-pack");
}

export function getManifestPath(): string {
  return path.join(getOpenerPackDir(), "manifest.json");
}

/** 解析 manifest JSON 字符串。非法返回 null。 */
export function parseManifest(raw: string): Manifest | null {
  try {
    const m = JSON.parse(raw) as Manifest;
    if (typeof m.version !== "number" || typeof m.packs !== "object" || m.packs === null) {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/** 加載 manifest。文件不存在或格式錯返回 null（runner 據此決定是否啟動）。 */
export function loadManifest(): Manifest | null {
  const p = getManifestPath();
  if (!fs.existsSync(p)) return BUILT_IN_TEXT_MANIFEST;
  return parseManifest(fs.readFileSync(p, "utf8")) ?? BUILT_IN_TEXT_MANIFEST;
}

export function hasExternalVoicePack(): boolean {
  const manifest = getManifestPath();
  if (!fs.existsSync(manifest)) return false;
  const parsed = parseManifest(fs.readFileSync(manifest, "utf8"));
  if (!parsed) return false;
  return Object.values(parsed.packs).some(pack => pack.items.some(item => Boolean(item.audio && resolveAudioPath(item.audio))));
}

/**
 * 從場景 items 裡選一條文案。
 * - 先過濾 condition 不滿足的（hourGte 等）
 * - 再排除 recent 列表裡的
 * - 剩下的隨機抽一條
 * 返回 null = 無可用 item。
 */
export function pickItem(
  items: ManifestItem[],
  hour: number,
  recent: string[],
): ManifestItem | null {
  const eligible = items.filter((it) => {
    if (it.condition?.hourGte !== undefined && hour < it.condition.hourGte) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // 文案數可能少於 recentAvoidN。全部都進過最近清單時允許重新循環，
  // 否則 runner 會每分鐘重試同一場景並持續輸出「無可用文案」。
  const fresh = eligible.filter((it) => !recent.includes(it.id));
  const candidates = fresh.length > 0 ? fresh : eligible;
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** 查 wav 文件存在性。返回絕對路徑或 null。 */
export function resolveAudioPath(audioRel: string): string | null {
  const abs = path.join(getOpenerPackDir(), audioRel);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 讀 wav 文件頭算時長（ms）。
 * 失敗返回 0。
 */
export function readWavDurationMs(wavPath: string): number {
  try {
    const fd = fs.openSync(wavPath, "r");
    try {
      const header = Buffer.alloc(44);
      fs.readSync(fd, header, 0, 44, 0);
      if (header.slice(0, 4).toString("ascii") !== "RIFF") return 0;
      const sampleRate = header.readUInt32LE(24);
      const channels = header.readUInt16LE(22);
      const bitsPerSample = header.readUInt16LE(34);
      if (!sampleRate || !channels || !bitsPerSample) return 0;
      // 找 data chunk（掃前 256 字節）
      const scan = Buffer.alloc(256);
      fs.readSync(fd, scan, 0, 256, 0);
      let dataOffset = -1;
      for (let i = 12; i < scan.length - 8; i++) {
        if (scan.slice(i, i + 4).toString("ascii") === "data") {
          dataOffset = i + 4;  // data size 字段位置
          break;
        }
      }
      if (dataOffset < 0) return 0;
      const dataSize = scan.readUInt32LE(dataOffset);
      const bytesPerSec = sampleRate * channels * bitsPerSample / 8;
      if (bytesPerSec <= 0) return 0;
      return Math.round((dataSize / bytesPerSec) * 1000);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/** 讀 wav 文件 base64（供 IPC 傳輸）。 */
export function readWavBase64(wavPath: string): string {
  return fs.readFileSync(wavPath).toString("base64");
}
