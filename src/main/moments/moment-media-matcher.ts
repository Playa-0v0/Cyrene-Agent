// Moments 后置配图匹配（设计文档 §7.5）：动态文本 → 贴图素材。
//
// 直接复用贴图系统已有资产（描述表、embedding 索引、相似度阈值），
// 不为 Moments 单独维护素材库：匹配命中 sticker id 后解析成
// 渲染端可直接消费的媒体引用（内置贴图 = public 相对路径，用户贴图 = local-sticker:// 协议）。
// 匹配失败（无索引 / 无 provider / 低于阈值 / id 解析不出）一律返回 null——
// 纯文字发帖，不硬凑图。

import { extractStickerEmbeddingText } from "../sticker-query";
import { BUILT_IN_STICKER_FILES } from "../sticker-descriptions";
import { buildLocalStickerUrl } from "../sticker-protocol";
import { loadUserStickerManifest } from "../sticker-storage";
import type { MomentMedia } from "../../shared/moments-types";

// ── 查询构建 ─────────────────────────────────────────────────────

/** 时间上下文给 embedding 的场景提示（贴图覆盖昼夜/情绪等场景）。 */
function timeOfDayContext(hour: number): string {
  if (hour >= 23 || hour < 5) return "深夜";
  if (hour < 8) return "清晨";
  if (hour < 11) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 21) return "傍晚";
  return "晚上";
}

/**
 * 配图查询 = 动态文案 + 触发摘录 + 时间上下文。
 * 复用 extractStickerEmbeddingText 清洗（代码/公式剔除），截断 1000 字符。
 */
export function buildMomentImageQuery(
  postText: string,
  summary: string,
  localNow: Date,
  maxLength = 1000,
): string {
  const parts = [
    extractStickerEmbeddingText(postText),
    extractStickerEmbeddingText(summary),
    timeOfDayContext(localNow.getHours()),
  ].filter(Boolean);
  return parts.join("\n").slice(0, maxLength);
}

// ── sticker id → MomentMedia ─────────────────────────────────────

/**
 * 把匹配命中的 sticker id 解析成 MomentMedia：
 * 内置贴图存 public 相对路径（渲染端 resolveAsset），用户贴图存 local-sticker:// 完整 URL。
 * id 两边都查不到（已删除的贴图）返回 null——调用方降级纯文字。
 */
export function resolveMomentStickerMedia(stickerId: string): MomentMedia | null {
  const builtInFile = BUILT_IN_STICKER_FILES[stickerId];
  if (builtInFile) {
    return {
      id: `media_sticker_${stickerId}`,
      type: "image",
      origin: "character_asset",
      ref: `stickers/${builtInFile}`,
    };
  }

  const meta = loadUserStickerManifest()[stickerId];
  if (meta?.file) {
    return {
      id: `media_sticker_${stickerId}`,
      type: "image",
      origin: "character_asset",
      ref: buildLocalStickerUrl(meta.file),
    };
  }
  return null;
}