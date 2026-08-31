import fs from "node:fs";
import path from "node:path";
import { getStickerSettingsPath } from "../settings-store";
import { getAllStickerConfig } from "../sticker-storage";
import type { StickerConfigItem } from "../../shared/sticker-types";

let stickerSettingsCache: Record<string, boolean> | null = null;

function loadStickerSettings0(): Record<string, boolean> {
  const filePath = getStickerSettingsPath();
  let raw: Record<string, unknown> = {};
  try {
    if (fs.existsSync(filePath)) {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    }
  } catch (err) {
    console.error("[StickerSettings] failed to load sticker settings:", err);
  }

  // 把所有 id 归一化为 boolean（默认 true）
  const result: Record<string, boolean> = {};
  for (const id of Object.keys(raw)) {
    result[id] = raw[id] !== false;
  }
  return result;
}

export function loadStickerSettings(): Record<string, boolean> {
  if (stickerSettingsCache !== null) return stickerSettingsCache;
  return (stickerSettingsCache = loadStickerSettings0());
}

export function saveStickerSettings(settings: Record<string, boolean>): Record<string, boolean> {
  const filePath = getStickerSettingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = loadStickerSettings();
  Object.assign(current, settings);
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2), "utf-8");
  return (stickerSettingsCache = current);
}

export function setStickerEnabled(id: string, enabled: boolean): Record<string, boolean> {
  const current = loadStickerSettings();
  current[id] = enabled;
  return saveStickerSettings(current);
}

export function getStickerManagerConfig(): StickerConfigItem[] {
  const stickerSettings = loadStickerSettings();
  return getAllStickerConfig(stickerSettings);
}

export function clearStickerSettingsCache(): void {
  stickerSettingsCache = null;
}
