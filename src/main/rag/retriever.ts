import { JsonVectorStore, SearchResult } from "./vectorstore";
import { EmbeddingProvider, getEmbeddingProvider } from "./embedding";

// ── @node-rs/jieba 分詞（Node 24 兼容；nodejieba 已棄用） ──
import { Jieba } from "@node-rs/jieba";

const jieba = new Jieba();

interface TokenInfo {
  word: string;
  tag: string;       // 詞性標註：n/ns/nr/v/a/d/p/c/u 等
  isStop: boolean;   // 是否為停用詞/高頻詞
  isNoun: boolean;   // 是否為名詞或專名
}

// ── 常用停用詞（~120 個高頻無意義字/詞） ──
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它",
  "有", "不", "也", "就", "都", "這", "那", "還", "要",
  "和", "與", "或", "但", "而", "且", "及", "之", "為",
  "上", "下", "中", "裡", "外", "前", "後", "左", "右",
  "到", "去", "來", "從", "把", "被", "讓", "給", "對",
  "嗎", "呢", "吧", "啊", "嘛", "哦", "嗯", "呀", "哇",
  "很", "太", "更", "最", "非", "沒", "將", "已", "能",
  "會", "可", "以", "好", "多", "少", "大", "小", "真",
  "個", "些", "點", "樣", "種", "些", "哪", "誰", "什",
  "做", "當", "看", "聽", "說", "想", "覺", "知", "道",
  "過", "完", "著", "住", "得", "地", "於", "其", "該",
  "我們", "你們", "他們", "她們", "它們",
  "自己", "什麼", "怎麼", "為什麼", "因為", "所以",
  "這個", "那個", "這些", "那些", "這裡", "那裡",
  "一個", "一種", "一些", "的話", "時候", "地方",
  "東西", "事情", "問題", "就是", "可以", "但是",
  "沒有", "不要", "不是", "不會", "不能", "應該",
  "已經", "可能", "覺得", "知道", "告訴",
]);

// 非名詞/非動詞的常見虛詞性標籤（BM25 應降權處理）
const STOP_TAGS = new Set(["u", "c", "p", "d", "r", "y", "o", "e", "m", "q", "f"]);
// 名詞性標籤（需加權）
const NOUN_TAGS = new Set(["n", "nr", "ns", "nt", "nz", "ng", "vn", "an"]);

/** 停用詞降權係數 */
const STOP_WEIGHT = 0.3;
/** 名詞加權係數 */
const NOUN_WEIGHT = 1.3;

// ── 自定義詞表（entity-graph 維護） ──
// @node-rs/jieba 沒有運行時 insertWord()，改用「後處理重組」方案：
// jieba 切完後，把被切散的自定義詞（如"昔漣"→"昔","漣"）重新合併。
const customWords = new Set<string>();

/** 註冊一個自定義詞（讓分詞時不被切散） */
export function registerJiebaCustomWord(word: string): void {
  if (word.length >= 2) customWords.add(word);
}

/** 批量註冊自定義詞 */
export function registerJiebaCustomWords(words: Iterable<string>): void {
  for (const w of words) {
    if (w.length >= 2) customWords.add(w);
  }
}

/** 後處理：在 jieba.cut() 的結果裡，把屬於自定義詞的連續 token 合併 */
function mergeCustomWords(tokens: string[]): string[] {
  if (customWords.size === 0 || tokens.length < 2) return tokens;

  // 按長度倒序排序，優先匹配長詞（避免"昔漣小助手"被錯誤合併成"昔漣小助手"）
  const sortedWords = [...customWords].sort((a, b) => b.length - a.length);

  // 用"窗口匹配"掃描：找到第一個能匹配的位置，合併若干個 token 為一個詞
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const word of sortedWords) {
      const wordTokens = word.split(""); // 單字數組
      // 檢查從 i 開始的連續 token 是否能拼成 word
      let ok = true;
      for (let j = 0; j < wordTokens.length; j++) {
        if (i + j >= tokens.length || tokens[i + j] !== wordTokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        result.push(word);
        i += wordTokens.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result.push(tokens[i]);
      i++;
    }
  }
  return result;
}

function tokenize(text: string): TokenInfo[] {
  // 純英文/數字文本走原來的空格分詞邏輯（jieba 不適合純英文）
  if (/^[a-zA-Z0-9\s]+$/.test(text)) {
    return text.split(/\s+/).filter(Boolean).map((word) => ({
      word: word.toLowerCase(),
      tag: "eng",
      isStop: false,
      isNoun: false,
    }));
  }

  try {
    // 第二個參數 hmm=true 讓 jieba 用 HMM 模型識別未登錄詞（如角色名"昔漣"）
    // 默認詞典不含"昔漣"等角色名，但 HMM 能根據上下文判斷這是個整體
    // 再疊加後處理：把 jieba 切散的自定義詞重組
    const rawCuts = jieba.cut(text, true);
    const mergedCuts = mergeCustomWords(rawCuts);

    // 用 jieba.tag 給重組後的詞打標籤（每個"詞"獨立 tag）
    // 重組後詞和原文本不對齊，所以對每個 merged token 單獨 tag
    const result: TokenInfo[] = [];
    for (const word of mergedCuts) {
      const tagged = jieba.tag(word, true);
      const first = tagged[0] ?? { word, tag: "x" };
      result.push({
        word: word.toLowerCase(),
        tag: first.tag,
        isStop: STOP_WORDS.has(word) || STOP_TAGS.has(first.tag),
        isNoun: NOUN_TAGS.has(first.tag),
      });
    }
    return result;
  } catch {
    // jieba 失敗時回退到單字切分
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

  // 文檔詞頻
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

    // 名詞加權：實際的信息載體，提高權重
    if (qt.isNoun) termScore *= NOUN_WEIGHT;
    // 停用詞降權：高頻無意義詞，降低干擾
    if (qt.isStop) termScore *= STOP_WEIGHT;

    score += termScore;
  }

  return score;
}

// ── 混合檢索器 ──
export class HybridRetriever {
  private store: JsonVectorStore;
  private provider: EmbeddingProvider | null;

  constructor(store: JsonVectorStore, provider?: EmbeddingProvider | null) {
    this.store = store;
    this.provider = provider ?? null;
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

    // 如果沒有 provider，向量檢索不可用，只用 BM25
    if (!this.provider) {
      const bm25Results = this.bm25Search(query, source, topK);
      return bm25Results;
    }

    // 1. Vector 檢索
    const vectorResults = await this.store.search(query, source, this.provider, topK * 3);

    // 2. BM25 檢索
    const bm25Results = this.bm25Search(query, source, topK * 3);

    // 3. 融合：加權求和
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

    // 歸一化 + 加權
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

    // 文檔頻率
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
      // 從 query 角度打分只考慮 query 包含的 token
      const queryWords = queryTokenInfo.map((t) => t.word);
      const docTokens = docTokensList[i];

      // 只對 query 中出現的詞做 BM25 計算
      const queryWordsSet = new Set(queryWords);
      const relevantDocTokens = docTokens.filter((t) => queryWordsSet.has(t.word));
      
      // 如果 doc 沒有命中任何 query 詞，分數為 0
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
