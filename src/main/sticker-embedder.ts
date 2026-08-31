// Embedding 表情包匹配引擎
// 将语义描述转向量，对 LLM 回复做余弦相似度匹配

import { type EmbeddingProvider } from "./rag/embedding";

// ── 余弦相似度 ──
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

// ── 类型 ──

/** Embedding 索引中的一条 */
export interface StickerEmbeddingEntry {
  id: string;
  embedding: number[];
}

// ── 公共 API ──

/**
 * 构建完整的 sticker embedding 索引
 * @param provider  embedding provider
 * @param builtIn   内置 sticker 描述 { id → { phrases } }
 * @param userStickers 用户 sticker 元数据 { id → { phrases } }
 * @returns 索引数组
 */
export async function buildStickerEmbeddingIndex(
  provider: EmbeddingProvider,
  builtIn: Record<string, { phrases: string[] }>,
  userStickers: Record<string, { phrases: string[] }>,
): Promise<StickerEmbeddingEntry[]> {
  const entries: StickerEmbeddingEntry[] = [];

  // 收集所有需要转向量的文本
  const allIds: string[] = [];
  const allTexts: string[] = [];

  for (const [id, desc] of Object.entries(builtIn)) {
    allIds.push(id);
    allTexts.push(desc.phrases.join("，"));
  }

  for (const [id, meta] of Object.entries(userStickers)) {
    allIds.push(id);
    allTexts.push(meta.phrases.join("，"));
  }

  if (allTexts.length === 0) return [];

  // 批量转向量
  const embeddings = await provider.embedBatch(allTexts);
  for (let i = 0; i < allIds.length; i++) {
    entries.push({ id: allIds[i], embedding: embeddings[i] });
  }

  return entries;
}

/**
 * 对查询文本做 embedding 匹配
 * @param query     LLM 回复内容（可拼接用户输入）
 * @param provider  embedding provider
 * @param index     embedding 索引
 * @param threshold 相似度阈值 0.3~0.9
 * @returns 匹配到的 sticker id 和分数，低于阈值返回 null
 */
export async function matchSticker(
  query: string,
  provider: EmbeddingProvider,
  index: StickerEmbeddingEntry[],
  threshold: number,
): Promise<{ id: string; score: number } | null> {
  if (index.length === 0) return null;

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
  return { id: bestId, score: bestScore };
}