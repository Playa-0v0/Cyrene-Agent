// 用戶表情包存儲管理
// 負責 userData/sticker-manifest.json 的增刪查
// 和 userData/stickers/ 目錄下的圖片文件管理

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { app } from "electron";
import { BUILT_IN_STICKER_FILES, BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { BUILT_IN_STICKER_IDS } from "../shared/sticker-types";
import type { UserStickerMeta, StickerConfigItem } from "../shared/sticker-types";
import { buildLocalStickerUrl } from "./sticker-protocol";

// ── 路徑 ──

export function getStickersDir(): string {
  return path.join(app.getPath("userData"), "stickers");
}

function getManifestPath(): string {
  return path.join(app.getPath("userData"), "sticker-manifest.json");
}

// ── Manifest 讀寫 ──

interface ManifestFile {
  schemaVersion: number;
  stickers: Record<string, UserStickerMeta>;
}

export function loadUserStickerManifest(): Record<string, UserStickerMeta> {
  try {
    const filePath = getManifestPath();
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ManifestFile;
    return raw.stickers ?? {};
  } catch (err) {
    console.error("[stickers] load manifest failed:", err);
    return {};
  }
}

function saveUserStickerManifest(stickers: Record<string, UserStickerMeta>): void {
  const filePath = getManifestPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data: ManifestFile = { schemaVersion: 1, stickers };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ── 增刪查 ──

/** 檢查 id 是否已被佔用 */
export function isStickerIdTaken(id: string): boolean {
  if (BUILT_IN_STICKER_IDS.includes(id as any)) return true;
  const manifest = loadUserStickerManifest();
  return id in manifest;
}

/** 添加用戶表情包：複製文件 + 寫入 manifest */
export async function addUserSticker(
  sourceFilePath: string,
  id: string,
  description: string,
  phrases: string[],
): Promise<void> {
  // 檢查 id
  if (isStickerIdTaken(id)) {
    throw new Error(`表情包 ID "${id}" 已存在`);
  }

  // 獲取擴展名
  const ext = path.extname(sourceFilePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
    throw new Error(`不支持的圖片格式: ${ext}`);
  }

  // 複製文件到 userData/stickers/
  const stickersDir = getStickersDir();
  fs.mkdirSync(stickersDir, { recursive: true });
  const destFile = `${id}${ext}`;
  const destPath = path.join(stickersDir, destFile);
  fs.copyFileSync(sourceFilePath, destPath);

  // 寫入 manifest
  const manifest = loadUserStickerManifest();
  manifest[id] = {
    id,
    file: destFile,
    description,
    phrases,
    createdAt: Date.now(),
  };
  saveUserStickerManifest(manifest);
}

/** 刪除用戶表情包：刪除文件 + 從 manifest 移除 */
export async function deleteUserSticker(id: string): Promise<void> {
  // 內置 sticker 不允許刪除
  if (BUILT_IN_STICKER_IDS.includes(id as any)) {
    throw new Error(`內置表情包 "${id}" 不能刪除，只能禁用`);
  }

  const manifest = loadUserStickerManifest();
  const meta = manifest[id];
  if (!meta) throw new Error(`表情包 "${id}" 不存在`);

  // 刪除文件
  const filePath = path.join(getStickersDir(), meta.file);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // 文件可能已被手動刪除，忽略
  }

  // 從 manifest 移除
  delete manifest[id];
  saveUserStickerManifest(manifest);
}

/** 獲取所有 sticker 的配置（內置 + 用戶），供表情包管理窗口/設置面板使用 */
export function getAllStickerConfig(
  stickerSettings: Record<string, boolean>,
): StickerConfigItem[] {
  const items: StickerConfigItem[] = [];

  // 內置
  for (const id of BUILT_IN_STICKER_IDS) {
    const file = BUILT_IN_STICKER_FILES[id];
    const desc = BUILT_IN_STICKER_DESCRIPTIONS[id];
    items.push({
      id,
      src: `/stickers/${file}`,
      enabled: stickerSettings[id] !== false,
      builtIn: true,
      description: desc ? desc.phrases.join("，") : id,
    });
  }

  // 用戶添加的
  const manifest = loadUserStickerManifest();
  for (const [id, meta] of Object.entries(manifest)) {
    items.push({
      id,
      src: getLocalStickerUrl(meta.file),
      enabled: stickerSettings[id] !== false,
      builtIn: false,
      description: meta.phrases.length > 0 ? meta.phrases.join("，") : meta.description,
    });
  }

  return items;
}

/** 獲取用戶 sticker 圖片的本地協議 URL */
export function getLocalStickerUrl(file: string): string {
  return buildLocalStickerUrl(file);
}

/** 獲取用戶 sticker 文件的本地磁盤路徑 */
export function getUserStickerFilePath(file: string): string {
  return path.join(getStickersDir(), file);
}

/**
 * 把表情包 id 解析成可交給 Discord AttachmentBuilder 的本機圖片路徑。
 * 內置圖片由 Vite 複製到 dist/renderer/stickers；自訂圖片位於 userData/stickers。
 */
export function resolveStickerImagePath(id: string): string | null {
  const builtInFile = BUILT_IN_STICKER_FILES[id];
  if (builtInFile) {
    const candidates = [
      path.join(__dirname, "..", "..", "renderer", "stickers", builtInFile),
      path.join(app.getAppPath(), "dist", "renderer", "stickers", builtInFile),
      path.join(app.getAppPath(), "src", "renderer", "public", "stickers", builtInFile),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  const userSticker = loadUserStickerManifest()[id];
  if (!userSticker) return null;
  const userPath = getUserStickerFilePath(userSticker.file);
  return fs.existsSync(userPath) ? userPath : null;
}
