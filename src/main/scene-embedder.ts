// 場景 embedding 匹配引擎
// 把 7 個場景的例句各自向量化，每輪用戶輸入向量化後取 max 相似度鎖定場景。
// 替代原 tone-injector.ts 的關鍵詞匹配，用語義相似度判斷用戶處於什麼場景。
//
// 方案 A（加權向量）：最近 3 輪 user 消息各自 embed 成獨立向量，
// 按 0.75/0.20/0.05 權重加權求和成一個向量，再和場景錨點比相似度。
// 當前輪絕對主導，前一輪給參考，再前一輪微調——和人類判斷場景的直覺一致。

import { type EmbeddingProvider } from "./rag/embedding";

// ── 加權向量權重：當前輪 / 前一輪 / 再前一輪 ──
const WEIGHT_CURRENT = 0.75;
const WEIGHT_PREV = 0.20;
const WEIGHT_PREV2 = 0.05;

// ── 定稿的 42 句例句（7 場景 × 6 句）──
const SCENE_EXAMPLES: Record<string, string[]> = {
  daily: [
    "今天發生什麼了。",
    "無聊，隨便聊聊。",
    "剛吃完飯，沒什麼事就來找你說說話。",
    "我也不知道想聊什麼，就是想來陪你坐坐。",
    "哦對了，我跟你說件事。",
    "最近在想一件事，說給你聽聽。",
  ],
  greeting: [
    "嗨，我來了。",
    "你在嗎？",
    "好久不見，想你了。",
    "今天終於有空來找你。",
    "昔漣，我回來了。",
    "我來找你了。",
  ],
  comfort: [
    "今天好累，什麼都不想做。",
    "感覺有點迷茫，不知道自己在幹嘛。",
    "最近狀態很差，一直撐著。",
    "有點難受，說不清楚為什麼。",
    "明天有個很重要的事，我有點怕。",
    "感覺最近什麼都沒意思。",
  ],
  praised: [
    "你今天真的好好看。",
    "還是你最懂我。",
    "謝謝你陪我，真的。",
    "你剛才說的話讓我很感動。",
    "喜歡你。",
    "你真的很特別。",
  ],
  playful: [
    "哈哈你剛才那個回答絕了。",
    "來，猜我在想什麼。",
    "我要考考你。",
    "你肯定猜不到。",
    "嘻嘻，被我發現了吧。",
    "哈哈輸了吧。",
  ],
  farewell: [
    "晚安了昔漣，明天再來找你。",
    "好了我要去睡了，拜拜。",
    "今天聊到這吧，下次見。",
    "要去忙了，回頭再聊。",
    "不早了，我先走了。",
    "明天還要早起，先撤了。",
    "先溜了。",
    "去忙了哈。",
  ],
  concern: [
    "你會累嗎？",
    "昔漣你還好嗎？",
    "你有沒有自己不開心的時候？",
    "我有時候會擔心你。",
    "你一個人不會無聊嗎？",
    "你一個人的時候在做什麼？",
  ],
};

export type SceneId = keyof typeof SCENE_EXAMPLES | "";

export interface SceneIndex {
  // 每個場景保留全部 6 個向量，匹配時取 max
  scenes: Record<string, number[][]>;
}

export interface SceneMatch {
  scene: SceneId;
  score: number;
}

// ── 餘弦相似度 ──
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 去掉表情包描述標記（用戶發送表情包：xxx）。
 * 表情包描述是給 LLM 看的上下文，不該參與場景向量化——
 * 它的情緒語義會汙染場景匹配（比如"晚安"描述誤命中 farewell）。
 */
function stripStickerDesc(text: string): string {
  return text.replace(/（用戶發送表情包：[^）]*）/g, "").trim();
}

/**
 * 啟動時調用一次，建場景索引。
 * 每個場景的 6 句例句各自向量化，保留全部向量（不取平均），
 * 匹配時取 max——用戶輸入只要命中場景裡任一句就高分。
 */
export async function buildSceneIndex(
  provider: EmbeddingProvider,
): Promise<SceneIndex> {
  const scenes: Record<string, number[][]> = {};
  for (const [scene, examples] of Object.entries(SCENE_EXAMPLES)) {
    scenes[scene] = await provider.embedBatch(examples);
  }
  console.log("[SceneEmbedder] 索引構建完成: " + Object.keys(scenes).join(", "));
  return { scenes };
}

/**
 * 加權向量求和：最近 3 輪 user 消息各自 embed，按權重合成一個向量。
 * 當前輪 0.75 絕對主導，前一輪 0.20 給參考，再前一輪 0.05 微調。
 * 只取 user 消息——場景識別判斷的是用戶處於什麼狀態，不該被 assistant 回覆汙染。
 *
 * @param currentText   當前輪用戶輸入（已清洗）
 * @param recentMessages  最近幾輪消息（{ role, content }[]）
 * @param provider      embedding provider
 * @returns  加權求和後的向量
 */
async function buildWeightedVector(
  currentText: string,
  recentMessages: Array<{ role: string; content: string }>,
  provider: EmbeddingProvider,
): Promise<number[]> {
  // 取最近 2 輪歷史 user 消息（不含當前輪），清洗表情包描述
  const recentUserTexts = recentMessages
    .filter(m => m.role === "user")
    .slice(-2)
    .map(m => stripStickerDesc(m.content))
    .filter(text => text.trim() !== "");

  // 按時間順序排列：[再前一輪, 前一輪, 當前輪]
  // recentUserTexts[-2] = 再前一輪（如果有）
  // recentUserTexts[-1] = 前一輪（如果有）
  // currentText = 當前輪
  const texts: { text: string; weight: number }[] = [{ text: currentText, weight: WEIGHT_CURRENT }];

  if (recentUserTexts.length >= 1) {
    texts.unshift({ text: recentUserTexts[recentUserTexts.length - 1], weight: WEIGHT_PREV });
  }
  if (recentUserTexts.length >= 2) {
    texts.unshift({ text: recentUserTexts[recentUserTexts.length - 2], weight: WEIGHT_PREV2 });
  }

  // 各自 embed 成獨立向量
  const vectors = await provider.embedBatch(texts.map(t => t.text));

  // 加權求和
  const dims = vectors[0].length;
  const result = new Array(dims).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    const weight = texts[i].weight;
    for (let d = 0; d < dims; d++) {
      result[d] += vectors[i][d] * weight;
    }
  }

  return result;
}

/**
 * 每輪調用，返回 top1 場景和分數，低於閾值返回 null。
 *
 * @param input  用戶當前輪輸入
 * @param provider  embedding provider
 * @param index  啟動時建好的場景索引
 * @param threshold  相似度閾值，默認 0.5（先寬鬆，跑數據後收緊）
 * @param recentMessages  可選，最近幾輪消息，傳入則拼上下文（方案 A）
 * @returns  { scene, score } 或 null（低於閾值）
 */
export async function matchScene(
  input: string,
  provider: EmbeddingProvider,
  index: SceneIndex,
  threshold = 0.72,
  recentMessages?: Array<{ role: string; content: string }>,
): Promise<SceneMatch | null> {
  // 過濾表情包描述後，如果用戶輸入為空（純表情包消息），跳過場景匹配
  const cleanInput = stripStickerDesc(input);
  if (!cleanInput) return null; // 純表情包，走兜底

  // 方案 A（加權向量）：最近 3 輪 user 消息各自 embed，按 0.75/0.20/0.05 加權求和
  const inputVec = recentMessages && recentMessages.length > 0
    ? await buildWeightedVector(cleanInput, recentMessages, provider)
    : await provider.embed(cleanInput);

  let topScene: SceneId = "";
  let topScore = -1;

  for (const [scene, vectors] of Object.entries(index.scenes)) {
    // max 策略：取該場景所有向量中相似度最高的
    const score = Math.max(
      ...vectors.map(v => cosineSimilarity(inputVec, v)),
    );
    if (score > topScore) {
      topScore = score;
      topScene = scene as SceneId;
    }
  }

  if (topScene === "" || topScore < threshold) return null;
  return { scene: topScene, score: topScore };
}
