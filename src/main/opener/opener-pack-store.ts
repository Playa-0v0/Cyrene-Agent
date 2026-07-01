// 扫描 manifest.json + 选文案 + 查 wav 存在性 + 读 wav 头算 durationMs
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { Manifest, ManifestItem } from "./opener-types";

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

/** 加载 manifest。文件不存在或格式错返回 null（runner 据此决定是否启动）。 */
export function loadManifest(): Manifest | null {
  const p = getManifestPath();
  if (!fs.existsSync(p)) return null;
  return parseManifest(fs.readFileSync(p, "utf8"));
}

/**
 * 从场景 items 里选一条文案。
 * - 先过滤 condition 不满足的（hourGte 等）
 * - 再排除 recent 列表里的
 * - 剩下的随机抽一条
 * 返回 null = 无可用 item。
 */
export function pickItem(
  items: ManifestItem[],
  hour: number,
  recent: string[],
): ManifestItem | null {
  const candidates = items.filter((it) => {
    if (it.condition?.hourGte !== undefined && hour < it.condition.hourGte) return false;
    if (recent.includes(it.id)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** 查 wav 文件存在性。返回绝对路径或 null。 */
export function resolveAudioPath(audioRel: string): string | null {
  const abs = path.join(getOpenerPackDir(), audioRel);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 读 wav 文件头算时长（ms）。
 * 失败返回 0。
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
      // 找 data chunk（扫前 256 字节）
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

/** 读 wav 文件 base64（供 IPC 传输）。 */
export function readWavBase64(wavPath: string): string {
  return fs.readFileSync(wavPath).toString("base64");
}
