// 场景 embedding 匹配引擎
// 把 7 个场景的例句各自向量化，每轮用户输入向量化后取 max 相似度锁定场景。
// 替代原 tone-injector.ts 的关键词匹配，用语义相似度判断用户处于什么场景。
//
// 方案 A（加权向量）：最近 3 轮 user 消息各自 embed 成独立向量，
// 按 0.75/0.20/0.05 权重加权求和成一个向量，再和场景锚点比相似度。
// 当前轮绝对主导，前一轮给参考，再前一轮微调——和人类判断场景的直觉一致。

import { type EmbeddingProvider } from "./rag/embedding";

// ── 加权向量权重：当前轮 / 前一轮 / 再前一轮 ──
const WEIGHT_CURRENT = 0.75;
const WEIGHT_PREV = 0.20;
const WEIGHT_PREV2 = 0.05;

// ── 定稿的 42 句例句（7 场景 × 6 句）──
export const SCENE_EXAMPLES: Record<string, string[]> = {
  daily: [
    "今天发生什么了。",
    "无聊，随便聊聊。",
    "刚吃完饭，没什么事就来找你说说话。",
    "我也不知道想聊什么，就是想来陪你坐坐。",
    "哦对了，我跟你说件事。",
    "最近在想一件事，说给你听听。",
  ],
  greeting: [
    "嗨，我来了。",
    "你在吗？",
    "好久不见，想你了。",
    "今天终于有空来找你。",
    "昔涟，我回来了。",
    "我来找你了。",
  ],
  comfort: [
    "今天好累，什么都不想做。",
    "感觉有点迷茫，不知道自己在干嘛。",
    "最近状态很差，一直撑着。",
    "有点难受，说不清楚为什么。",
    "明天有个很重要的事，我有点怕。",
    "感觉最近什么都没意思。",
  ],
  praised: [
    "你今天真的好好看。",
    "还是你最懂我。",
    "谢谢你陪我，真的。",
    "你刚才说的话让我很感动。",
    "喜欢你。",
    "你真的很特别。",
  ],
  playful: [
    "哈哈你刚才那个回答绝了。",
    "来，猜我在想什么。",
    "我要考考你。",
    "你肯定猜不到。",
    "嘻嘻，被我发现了吧。",
    "哈哈输了吧。",
  ],
  farewell: [
    "晚安了昔涟，明天再来找你。",
    "好了我要去睡了，拜拜。",
    "今天聊到这吧，下次见。",
    "要去忙了，回头再聊。",
    "不早了，我先走了。",
    "明天还要早起，先撤了。",
    "先溜了。",
    "去忙了哈。",
  ],
  concern: [
    "你会累吗？",
    "昔涟你还好吗？",
    "你有没有自己不开心的时候？",
    "我有时候会担心你。",
    "你一个人不会无聊吗？",
    "你一个人的时候在做什么？",
  ],
};

export type SceneId = keyof typeof SCENE_EXAMPLES | "";

export interface SceneIndex {
  // 每个场景保留全部 6 个向量，匹配时取 max
  scenes: Record<string, number[][]>;
}

export interface SceneMatch {
  scene: SceneId;
  score: number;
}

// ── 余弦相似度 ──
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
 * 去掉表情包描述标记（用户发送表情包：xxx）。
 * 表情包描述是给 LLM 看的上下文，不该参与场景向量化——
 * 它的情绪语义会污染场景匹配（比如"晚安"描述误命中 farewell）。
 */
function stripStickerDesc(text: string): string {
  return text.replace(/（用户发送表情包：[^）]*）/g, "").trim();
}

/**
 * 启动时调用一次，建场景索引。
 * 每个场景的 6 句例句各自向量化，保留全部向量（不取平均），
 * 匹配时取 max——用户输入只要命中场景里任一句就高分。
 */
export async function buildSceneIndex(
  provider: EmbeddingProvider,
): Promise<SceneIndex> {
  const scenes: Record<string, number[][]> = {};
  for (const [scene, examples] of Object.entries(SCENE_EXAMPLES)) {
    scenes[scene] = await provider.embedBatch(examples);
  }
  console.log("[SceneEmbedder] 索引构建完成: " + Object.keys(scenes).join(", "));
  return { scenes };
}

/**
 * 加权向量求和：最近 3 轮 user 消息各自 embed，按权重合成一个向量。
 * 当前轮 0.75 绝对主导，前一轮 0.20 给参考，再前一轮 0.05 微调。
 * 只取 user 消息——场景识别判断的是用户处于什么状态，不该被 assistant 回复污染。
 *
 * @param currentText   当前轮用户输入（已清洗）
 * @param recentMessages  最近几轮消息（{ role, content }[]）
 * @param provider      embedding provider
 * @returns  加权求和后的向量
 */
async function buildWeightedVector(
  currentText: string,
  recentMessages: Array<{ role: string; content: string }>,
  provider: EmbeddingProvider,
): Promise<number[]> {
  // 取最近 2 轮历史 user 消息（不含当前轮），清洗表情包描述
  const recentUserTexts = recentMessages
    .filter(m => m.role === "user")
    .slice(-2)
    .map(m => stripStickerDesc(m.content))
    .filter(text => text.trim() !== "");

  // 按时间顺序排列：[再前一轮, 前一轮, 当前轮]
  // recentUserTexts[-2] = 再前一轮（如果有）
  // recentUserTexts[-1] = 前一轮（如果有）
  // currentText = 当前轮
  const texts: { text: string; weight: number }[] = [{ text: currentText, weight: WEIGHT_CURRENT }];

  if (recentUserTexts.length >= 1) {
    texts.unshift({ text: recentUserTexts[recentUserTexts.length - 1], weight: WEIGHT_PREV });
  }
  if (recentUserTexts.length >= 2) {
    texts.unshift({ text: recentUserTexts[recentUserTexts.length - 2], weight: WEIGHT_PREV2 });
  }

  // 各自 embed 成独立向量
  const vectors = await provider.embedBatch(texts.map(t => t.text));

  // 加权求和
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
 * 每轮调用，返回 top1 场景和分数，低于阈值返回 null。
 *
 * @param input  用户当前轮输入
 * @param provider  embedding provider
 * @param index  启动时建好的场景索引
 * @param threshold  相似度阈值，默认 0.5（先宽松，跑数据后收紧）
 * @param recentMessages  可选，最近几轮消息，传入则拼上下文（方案 A）
 * @returns  { scene, score } 或 null（低于阈值）
 */
export async function matchScene(
  input: string,
  provider: EmbeddingProvider,
  index: SceneIndex,
  threshold = 0.72,
  recentMessages?: Array<{ role: string; content: string }>,
): Promise<SceneMatch | null> {
  // 过滤表情包描述后，如果用户输入为空（纯表情包消息），跳过场景匹配
  const cleanInput = stripStickerDesc(input);
  if (!cleanInput) return null; // 纯表情包，走兜底

  // 方案 A（加权向量）：最近 3 轮 user 消息各自 embed，按 0.75/0.20/0.05 加权求和
  const inputVec = recentMessages && recentMessages.length > 0
    ? await buildWeightedVector(cleanInput, recentMessages, provider)
    : await provider.embed(cleanInput);

  let topScene: SceneId = "";
  let topScore = -1;

  for (const [scene, vectors] of Object.entries(index.scenes)) {
    // max 策略：取该场景所有向量中相似度最高的
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
