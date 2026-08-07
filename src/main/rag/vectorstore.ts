import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProvider, EmbeddingProvider } from "./embedding";

// ── 類型 ──
export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  source: string;       // "user_memory" | "worldbook" | "imported_doc"
  weight: number;       // 1.0 初始，每次召回 +0.1，24h 未提 ×0.95
  createdAt: number;    // timestamp
  lastRecalledAt: number;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;        // 加權後的綜合分數（餘弦 × weight × 衰減）
}

// ── 餘弦相似度（嵌入已歸一化，等價於點積） ──
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ── IVF 倒排文件索引 ──
// 用 k-means 把向量聚成 K 個簇，搜索時只查最近的 nprobe 個簇，
// 將 O(n) 變為 O(n / K * nprobe) ≈ O(√n)。
interface IvfIndex {
  /** 簇中心向量（已歸一化） */
  centroids: number[][];
  /** 每個簇中的條目 index（指向 this.entries） */
  clusters: number[][];
  /** 建索引時的條目數，用於判定是否需要重建 */
  entryCount: number;
}

function kmeansPlusPlusInit(
  vectors: number[][],
  K: number,
  dim: number,
): number[][] {
  const centroids: number[][] = [];
  // 1. 隨機選第一個中心
  const firstIdx = Math.floor(Math.random() * vectors.length);
  centroids.push(vectors[firstIdx].slice());

  // 2. 按距離平方加權選剩下的
  for (let c = 1; c < K; c++) {
    const dists = vectors.map((v) => {
      let minDist = Infinity;
      for (const cent of centroids) {
        const sim = cosineSimilarity(v, cent);
        const d = 1 - sim; // 餘弦距離 = 1 - cos
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });
    const totalDist = dists.reduce((a, b) => a + b, 0);
    if (totalDist <= 0) break;
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push(vectors[i].slice());
        break;
      }
    }
  }
  return centroids;
}

function buildIvfIndex(
  entries: MemoryEntry[],
  K: number,
  maxIter = 20,
): IvfIndex {
  const vectors = entries.map((e) => e.embedding);
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0 || vectors.length === 0) {
    return { centroids: [], clusters: [], entryCount: entries.length };
  }

  const effectiveK = Math.min(K, vectors.length);
  const clusters: number[][] = Array.from({ length: effectiveK }, () => []);

  // k-means++ 初始化
  let centroids = kmeansPlusPlusInit(vectors, effectiveK, dim);

  for (let iter = 0; iter < maxIter; iter++) {
    // 分配
    for (let i = 0; i < effectiveK; i++) clusters[i] = [];
    let changed = false;

    for (let i = 0; i < vectors.length; i++) {
      let bestIdx = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const sim = cosineSimilarity(vectors[i], centroids[c]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = c;
        }
      }
      clusters[bestIdx].push(i);
    }

    // 更新中心
    const newCentroids: number[][] = [];
    for (let c = 0; c < effectiveK; c++) {
      const members = clusters[c];
      if (members.length === 0) {
        // 空簇保留原中心
        newCentroids.push(centroids[c].slice());
        continue;
      }
      const sum = new Array(dim).fill(0);
      for (const idx of members) {
        const v = vectors[idx];
        for (let d = 0; d < dim; d++) sum[d] += v[d];
      }
      // 歸一化新中心
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += sum[d] * sum[d];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < dim; d++) sum[d] /= norm;
      }
      newCentroids.push(sum);
    }

    // 檢查收斂
    for (let c = 0; c < effectiveK; c++) {
      const sim = cosineSimilarity(newCentroids[c], centroids[c]);
      if (sim < 0.999) { changed = true; break; }
    }
    centroids = newCentroids;
    if (!changed) break;
  }

  return { centroids, clusters, entryCount: entries.length };
}

// ── JSON 向量存儲 ──
export class JsonVectorStore {
  private filePath: string;
  private entries: MemoryEntry[] = [];
  private dirty = false;

  /** IVF 索引，null = 未構建或需要重建 */
  private ivf: IvfIndex | null = null;
  /** 搜索次數計數，達到閾值時惰性重建索引 */
  private searchCount = 0;

  constructor(dbPath: string) {
    this.filePath = path.join(dbPath, "memory-store.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        this.entries = JSON.parse(raw) as MemoryEntry[];
      }
    } catch (err) {
      console.warn("[RAG] failed to load vector store:", err);
      this.entries = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      console.warn("[RAG] failed to save vector store:", err);
    }
  }

  // ── IVF 索引管理 ──

  /** 強制重建 IVF 索引 */
  rebuildIndex(): void {
    const n = this.entries.length;
    if (n < 2) {
      this.ivf = null;
      return;
    }
    // K ≈ sqrt(n)/2，上限 512，下限 2
    const K = Math.max(2, Math.min(512, Math.round(Math.sqrt(n) / 2)));
    const t0 = Date.now();
    this.ivf = buildIvfIndex(this.entries, K);
    console.log(`[RAG] IVF index rebuilt: K=${K}, entries=${n}, took ${Date.now() - t0}ms`);
  }

  /** 檢查是否需重建索引，每次數據庫變化後調用 */
  private markIndexDirty(): void {
    this.ivf = null;
  }

  /** 搜索前確保索引可用（惰性重建） */
  private ensureIndex(): void {
    if (this.ivf) return;
    if (this.entries.length >= 2) {
      this.rebuildIndex();
    }
  }

  // ── CRUD ──

  // 添加記憶（自動去重）
  async add(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    // 一般知識可做語義去重；逐字對話歷史不可去重，否則兩次相同的原話會被錯當成同一事件。
    if (source !== "chat_history") {
      const existing = await this.search(text, source, provider, 1, 0.95);
      if (existing.length > 0) {
        // 更新權重和時間
        existing[0].entry.weight = Math.min(existing[0].entry.weight + 0.1, 5.0);
        existing[0].entry.lastRecalledAt = Date.now();
        this.dirty = true;
        this.save();
        return existing[0].entry;
      }
    }

    const embedding = await provider.embed(text);
    const entry: MemoryEntry = {
      id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      embedding,
      source,
      weight: 1.0,
      createdAt: Date.now(),
      lastRecalledAt: Date.now(),
      metadata,
    };

    this.entries.push(entry);
    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return entry;
  }

  // 批量添加（用於導入文檔 chunk）
  async addBatch(
    items: Array<{ text: string; source: string; metadata?: Record<string, unknown> }>,
    provider: EmbeddingProvider
  ): Promise<MemoryEntry[]> {
    const texts = items.map((i) => i.text);
    const embeddings = await provider.embedBatch(texts);
    const results: MemoryEntry[] = [];

    for (let i = 0; i < items.length; i++) {
      const entry: MemoryEntry = {
        id: `${items[i].source}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        text: items[i].text,
        embedding: embeddings[i],
        source: items[i].source,
        weight: 1.0,
        createdAt: Date.now(),
        lastRecalledAt: Date.now(),
        metadata: items[i].metadata,
      };
      this.entries.push(entry);
      results.push(entry);
    }

    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return results;
  }

  /** 依穩定 id 刪除單一向量條目。 */
  removeById(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.id !== id);
    if (this.entries.length === before) return false;
    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return true;
  }

  // 搜索（使用 IVF 索引加速）
  async search(
    query: string,
    source?: string,
    provider?: EmbeddingProvider,
    topK = 5,
    minScore = 0.3
  ): Promise<SearchResult[]> {
    if (this.entries.length === 0) return [];

    const embeddingProvider = provider ?? getEmbeddingProvider();
    if (!embeddingProvider) return [];

    const queryEmbedding = await embeddingProvider.embed(query);

    // 確保索引已構建
    this.ensureIndex();

    const now = Date.now();
    const results: SearchResult[] = [];

    if (this.ivf && !source) {
      // ── IVF 加速路徑（無 source 過濾時） ──
      const K = this.ivf.centroids.length;
      // nprobe：搜索約 1/8 的簇（至少 2 個）
      const nprobe = Math.max(2, Math.round(K / 8));

      // 找最近的 nprobe 個簇
      const clusterDists: Array<{ idx: number; dist: number }> = [];
      for (let c = 0; c < K; c++) {
        const sim = cosineSimilarity(queryEmbedding, this.ivf.centroids[c]);
        clusterDists.push({ idx: c, dist: 1 - sim });
      }
      clusterDists.sort((a, b) => a.dist - b.dist);
      const probeClusters = new Set(clusterDists.slice(0, nprobe).map((c) => c.idx));

      // 只在選中簇內搜索
      for (const clusterIdx of probeClusters) {
        for (const entryIdx of this.ivf.clusters[clusterIdx]) {
          const entry = this.entries[entryIdx];
          const sim = cosineSimilarity(queryEmbedding, entry.embedding);
          const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
          const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
          const weightedScore = sim * entry.weight * decayFactor;

          if (weightedScore >= minScore) {
            results.push({ entry, score: weightedScore });
          }
        }
      }
    } else {
      // ── 全量搜索路徑（有 source 過濾時，或索引未就緒） ──
      for (const entry of this.entries) {
        if (source && entry.source !== source) continue;

        const sim = cosineSimilarity(queryEmbedding, entry.embedding);
        // 時間衰減：24h 未提及權重 ×0.95
        const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
        const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
        const weightedScore = sim * entry.weight * decayFactor;

        if (weightedScore >= minScore) {
          results.push({ entry, score: weightedScore });
        }
      }
    }

    // 排序並取 topK
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    // 更新召回時間（僅對 topK 結果）
    for (const r of top) {
      r.entry.lastRecalledAt = now;
      r.entry.weight = Math.min(r.entry.weight + 0.05, 5.0);
    }
    if (top.length > 0) {
      this.dirty = true;
      this.save();
    }

    return top;
  }

  // 清理低權重記憶
  prune(minWeight = 0.1): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.weight >= minWeight);
    this.dirty = true;
    this.markIndexDirty();
    this.save();
    return before - this.entries.length;
  }

  // 刪除導入文檔
  deleteImportedDoc(importId: string, fileName?: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (e.source !== "imported_doc") return true;
      // 新數據：按 importId 精確匹配
      if (e.metadata?.importId) {
        return e.metadata.importId !== importId;
      }
      // 舊數據：按 fileName 匹配
      if (fileName && e.metadata?.fileName === fileName) {
        return false;
      }
      return true;
    });
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.dirty = true;
      this.markIndexDirty();
      this.save();
    }
    return deleted;
  }

  // 統計
  get stats() {
    const sources: Record<string, number> = {};
    for (const e of this.entries) {
      sources[e.source] = (sources[e.source] || 0) + 1;
    }
    return { total: this.entries.length, sources };
  }
}
