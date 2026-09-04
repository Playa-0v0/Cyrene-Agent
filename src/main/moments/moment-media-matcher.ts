// Moments 后置配图匹配（设计文档 §7.5）：动态文本 → 官方素材。
//
// 复用 sticker 系列验证过的链路（余弦匹配 + 文本清洗），但独立实现：
// 独立索引、独立阈值，不出现 MomentImage extends Sticker 这类领域混血。
// 匹配失败（无索引 / 无 provider / 低于阈值）一律返回 null——纯文字发帖，
// 不硬凑图。

import type { EmbeddingProvider } from "../rag/embedding";
import { extractStickerEmbeddingText } from "../sticker-query";
import { BUILT_IN_MOMENT_ASSET_DESCRIPTIONS } from "./moment-asset-descriptions";

/** Moment 素材索引中的一条（与 sticker 索引同构但独立）。 */
export interface MomentAssetEmbeddingEntry {
  id: string;
  embedding: number[];
}

export interface MomentAssetMatch {
  id: string;
  /** 命中素材的文件名（public/moments/ 下），作为 MomentMedia.ref */
  file: string;
  score: number;
}

// ── 查询构建 ─────────────────────────────────────────────────────

/** 时间上下文给 embedding 的场景提示（素材覆盖昼夜/天气等场景）。 */
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

// ── 余弦匹配（照 sticker-embedder.ts 复制，模块独立） ─────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 查询文本 → 素材匹配：取余弦最高的素材，低于阈值返回 null。
 * 索引为空直接返回 null（纯文字降级，不硬凑图）。
 */
export async function matchMomentAsset(
  query: string,
  provider: EmbeddingProvider,
  index: readonly MomentAssetEmbeddingEntry[],
  threshold: number,
): Promise<MomentAssetMatch | null> {
  if (!query.trim() || index.length === 0) return null;

  const queryEmbedding = await provider.embed(query);
  let bestId: string | null = null;
  let bestScore = -1;
  for (const entry of index) {
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestId = entry.id;
    }
  }

  if (bestId === null || bestScore < threshold) return null;
  const description = BUILT_IN_MOMENT_ASSET_DESCRIPTIONS[bestId];
  // 索引里有 id 但描述表缺失（素材被移除）：视为未命中
  if (!description) return null;
  return { id: description.id, file: description.file, score: bestScore };
}