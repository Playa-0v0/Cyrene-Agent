import { JsonVectorStore, SearchResult } from "./vectorstore";
import { EmbeddingProvider, getEmbeddingProvider } from "./embedding";

// ── nodejieba 分词 ──
import jieba from "nodejieba";

interface TokenInfo {
  word: string;
  tag: string;       // 词性标注：n/ns/nr/v/a/d/p/c/u 等
  isStop: boolean;   // 是否为停用词/高频词
  isNoun: boolean;   // 是否为名词或专名
}

// ── 常用停用词（~120 个高频无意义字/词） ──
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它",
  "有", "不", "也", "就", "都", "这", "那", "还", "要",
  "和", "与", "或", "但", "而", "且", "及", "之", "为",
  "上", "下", "中", "里", "外", "前", "后", "左", "右",
  "到", "去", "来", "从", "把", "被", "让", "给", "对",
  "吗", "呢", "吧", "啊", "嘛", "哦", "嗯", "呀", "哇",
  "很", "太", "更", "最", "非", "没", "将", "已", "能",
  "会", "可", "以", "好", "多", "少", "大", "小", "真",
  "个", "些", "点", "样", "种", "些", "哪", "谁", "什",
  "做", "当", "看", "听", "说", "想", "觉", "知", "道",
  "过", "完", "着", "住", "得", "地", "于", "其", "该",
  "我们", "你们", "他们", "她们", "它们",
  "自己", "什么", "怎么", "为什么", "因为", "所以",
  "这个", "那个", "这些", "那些", "这里", "那里",
  "一个", "一种", "一些", "的话", "时候", "地方",
  "东西", "事情", "问题", "就是", "可以", "但是",
  "没有", "不要", "不是", "不会", "不能", "应该",
  "已经", "可能", "觉得", "知道", "告诉",
]);

// 非名词/非动词的常见虚词性标签（BM25 应降权处理）
const STOP_TAGS = new Set(["u", "c", "p", "d", "r", "y", "o", "e", "m", "q", "f"]);
// 名词性标签（需加权）
const NOUN_TAGS = new Set(["n", "nr", "ns", "nt", "nz", "ng", "vn", "an"]);

/** 停用词降权系数 */
const STOP_WEIGHT = 0.3;
/** 名词加权系数 */
const NOUN_WEIGHT = 1.3;

function tokenize(text: string): TokenInfo[] {
  // 纯英文/数字文本走原来的空格分词逻辑（jieba 不适合纯英文）
  if (/^[a-zA-Z0-9\s]+$/.test(text)) {
    return text.split(/\s+/).filter(Boolean).map((word) => ({
      word: word.toLowerCase(),
      tag: "eng",
      isStop: false,
      isNoun: false,
    }));
  }

  try {
    const tagged = jieba.tag(text);
    return tagged.map(({ word, tag }) => ({
      word: word.toLowerCase(),
      tag,
      isStop: STOP_WORDS.has(word) || STOP_TAGS.has(tag),
      isNoun: NOUN_TAGS.has(tag),
    }));
  } catch {
    // jieba 失败时回退到单字切分
    const tokens: TokenInfo[] = [];
    const seg = text.split(/([\u4e00-\u9fff]|[a-zA-Z]+|\d+)/).filter(Boolean);
    for (const s of seg) {
      if (/[\u4e00-\u9fff]/.test(s)) {
        for (const c of s) {
          tokens.push({ word: c, tag: "x", isStop: STOP_WORDS.has(c), isNoun: false });
        }
      } else {
        tokens.push({ word: s.toLowerCase(), tag: "eng", isStop: false, isNoun: false });
      }
    }
    return tokens;
  }
}

function bm25Score(
  queryTokens: TokenInfo[],
  docTokens: TokenInfo[],
  docFreq: Map<string, number>,
  totalDocs: number,
  avgDocLen: number
): number {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  // 文档词频
  const tf: Map<string, number> = new Map();
  for (const t of docTokens) {
    tf.set(t.word, (tf.get(t.word) || 0) + 1);
  }

  for (const qt of queryTokens) {
    const df = docFreq.get(qt.word) || 0;
    if (df === 0) continue;

    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const termFreq = tf.get(qt.word) || 0;
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (avgDocLen ? docTokens.length / avgDocLen : 1));
    let termScore = idf * (numerator / denominator);

    // 名词加权：实际的信息载体，提高权重
    if (qt.isNoun) termScore *= NOUN_WEIGHT;
    // 停用词降权：高频无意义词，降低干扰
    if (qt.isStop) termScore *= STOP_WEIGHT;

    score += termScore;
  }

  return score;
}

// ── 混合检索器 ──
export class HybridRetriever {
  private store: JsonVectorStore;
  private provider: EmbeddingProvider;

  constructor(store: JsonVectorStore, provider?: EmbeddingProvider) {
    this.store = store;
    this.provider = provider || getEmbeddingProvider();
  }

  async retrieve(
    query: string,
    source?: string,
    topK = 5,
    vectorWeight = 0.7,
    bm25Weight = 0.3
  ): Promise<SearchResult[]> {
    const stats = this.store.stats;
    if (stats.total === 0) return [];

    // 1. Vector 检索
    const vectorResults = await this.store.search(query, source, this.provider, topK * 3);

    // 2. BM25 检索
    const bm25Results = this.bm25Search(query, source, topK * 3);

    // 3. 融合：加权求和
    const merged: Map<string, { result: SearchResult; vectorScore: number; bm25Score: number }> = new Map();

    for (const r of vectorResults) {
      merged.set(r.entry.id, { result: r, vectorScore: r.score, bm25Score: 0 });
    }

    for (const r of bm25Results) {
      const existing = merged.get(r.entry.id);
      if (existing) {
        existing.bm25Score = r.score;
      } else {
        merged.set(r.entry.id, { result: r, vectorScore: 0, bm25Score: r.score });
      }
    }

    // 归一化 + 加权
    const all = Array.from(merged.values());
    const maxV = Math.max(...all.map((m) => m.vectorScore), 1);
    const maxB = Math.max(...all.map((m) => m.bm25Score), 1);

    const scored = all.map((m) => ({
      ...m.result,
      score: (m.vectorScore / maxV) * vectorWeight + (m.bm25Score / maxB) * bm25Weight,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private bm25Search(query: string, source?: string, topK = 15): SearchResult[] {
    const entries = this.store["entries"] as Array<{
      id: string; text: string; embedding: number[]; source: string;
      weight: number; createdAt: number; lastRecalledAt: number; metadata?: Record<string, unknown>;
    }>;

    const docs = source ? entries.filter((e) => e.source === source) : entries;
    if (docs.length === 0) return [];

    const queryTokenInfo = tokenize(query);
    const docTokensList = docs.map((d) => tokenize(d.text));
    const totalDocs = docs.length;
    const avgDocLen = docTokensList.reduce((sum, t) => sum + t.length, 0) / totalDocs;

    // 文档频率
    const docFreq = new Map<string, number>();
    for (const tokens of docTokensList) {
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t.word)) {
          docFreq.set(t.word, (docFreq.get(t.word) || 0) + 1);
          seen.add(t.word);
        }
      }
    }

    const scored = docs.map((doc, i) => {
      // 从 query 角度打分只考虑 query 包含的 token
      const queryWords = queryTokenInfo.map((t) => t.word);
      const docTokens = docTokensList[i];

      // 只对 query 中出现的词做 BM25 计算
      const queryWordsSet = new Set(queryWords);
      const relevantDocTokens = docTokens.filter((t) => queryWordsSet.has(t.word));
      
      // 如果 doc 没有命中任何 query 词，分数为 0
      if (relevantDocTokens.length === 0) {
        return {
          entry: {
            id: doc.id,
            text: doc.text,
            embedding: doc.embedding,
            source: doc.source,
            weight: doc.weight,
            createdAt: doc.createdAt,
            lastRecalledAt: doc.lastRecalledAt,
            metadata: doc.metadata,
          },
          score: 0,
        };
      }

      return {
        entry: {
          id: doc.id,
          text: doc.text,
          embedding: doc.embedding,
          source: doc.source,
          weight: doc.weight,
          createdAt: doc.createdAt,
          lastRecalledAt: doc.lastRecalledAt,
          metadata: doc.metadata,
        },
        score: bm25Score(queryTokenInfo, docTokens, docFreq, totalDocs, avgDocLen),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
