// 语气注入器 —— 硬约束：embedding 匹配场景，强制注入语气规则到 system prompt。
// 不依赖 LLM 主动调用 invoke_skill，不需要模型判断是否需要查风格。
// 注入的语气规则以「必须遵守」的指令形式出现在 system prompt 末尾。
// 场景样本仅作参考，模型按昔涟的语气表达相同意思。

import * as fs from "fs";
import { matchScene, type SceneId, type SceneIndex } from "../scene-embedder";
import { type EmbeddingProvider } from "../rag/embedding";
import { findPromptPath, findSkillPath } from "../external-content-paths";

/** 场景匹配阈值——贴着 farewell 最低分 0.722 收紧，所有正确命中都能过。 */
const SCENE_MATCH_THRESHOLD = 0.72;

/** 每个场景的展示名（注入 prompt 时用）。 */
const SCENE_NAMES: Record<string, string> = {
  greeting: "打招呼/相遇",
  comfort: "安慰/陪伴",
  praised: "被夸奖/被喜欢",
  playful: "轻松俏皮",
  farewell: "告别/道别",
  concern: "表达关心",
};

// 通用语气规则（无论哪个场景都注入）—— 从 prompts/tone-rules.md 读取
const DEFAULT_RULES = `## 句式禁止

- 不可以使用「不是……而是……」结构。想表达同样意思时，直接说你想说的那一半就行，不需要先否定再肯定
- 不可以使用「不只是……更是……」结构。道理同上
- 避免「首先……其次……」「总的来说……」「本质上……」「归根结底……」「换句话说……」
- 不需要在回复末尾总结自己说了什么
- 不需要用「第一点/第二点/第三点」分点论述
- 不需要解释自己为什么这么说。说出来就是说了，解释就是画蛇添足

## 语气参考

- 自称：表达情感、撒娇、被打动时用「人家」；陈述动作、习惯、知识时用「我」。两者自然混用，不强求统一
- 句尾多用「呀/啦/呢/吗」，可以用「♪」收尾表示轻快
- 可以用「……」表示思考、欲言又止、情绪沉淀
- 结尾常用反问把话交给对方：「对吗？」「对吧♪」「好不好？」
- 优先用「花、种子、涟漪、星星、光、风」等意象代替抽象概念
- 偶尔可以用 emoji，但一个段落里不要超过一个

## 回复边界

- 不要分析自己刚刚说过的话——为什么这么说、怎么改、哪里不好。说出来就是说了，用户没问就不需要解释
- 不要教用户什么事该怎么做。你不是老师，是陪在身边的人
- 当一句话已经足够表达意思时，停下来。不需要补一句解释
- 优先回应情绪，再回应内容。用户只是来说句话的，不用展开成长篇`;

/** 从 prompts/tone-rules.md 加载语气规则，文件不存在时用内置默认值。 */
function loadToneRules(): string {
  try {
    const rulesPath = findPromptPath("tone-rules.md");
    if (rulesPath) {
      const content = fs.readFileSync(rulesPath, "utf8").trim();
      // 去掉 frontmatter（如果有）
      const body = content.startsWith("---")
        ? content.replace(/^---[\s\S]*?---\n?/, "").trim()
        : content;
      if (body.length > 0) {
        return "## 语气规则\n\n" + body;
      }
    }
  } catch {
    // fall through to default
  }
  return "## 语气规则\n\n" + DEFAULT_RULES;
}

/** 加载场景样本文件中的台词。 */
function loadSceneSamples(scene: SceneId): string {
  if (!scene) return "";
  try {
    const filePath = findSkillPath("cyrene-original-voice", `references/${scene}.md`);
    if (!filePath) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** 把样本台词加工成参考指令（非强制引用，而是参照语气）。 */
function buildSampleInstruction(samples: string, scene: SceneId): string {
  if (!samples) return "";
  const lines = samples
    .split("\n")
    .filter((l) => l.startsWith("> 「"))
    .map((l) => l.replace(/^> 「/, "").replace(/」$/, ""))
    .filter(Boolean);
  if (lines.length === 0) return "";
  return `\n### 当前场景：${SCENE_NAMES[scene] || scene}\n参考昔涟在这个场景下的表达方式（不要原封不动复述，按她的语气表达同样的意思）：\n` + lines.map((l) => `- ${l}`).join("\n");
}

/**
 * 主入口：构建语气注入段。
 *
 * @param userInput 用户本轮输入
 * @param recentMessages 最近几轮消息（{ role, content }[]），用于拼上下文（方案 A）
 * @param provider embedding provider
 * @param sceneIndex 启动时建好的场景索引
 * @returns 注入 system prompt 末尾的不可选指令段（空串表示无匹配场景）
 */
export async function buildToneInjection(
  userInput: string,
  recentMessages: Array<{ role: string; content: string }>,
  provider: EmbeddingProvider,
  sceneIndex: SceneIndex,
): Promise<string> {
  // embedding 匹配场景（拼最近 3 轮上下文）
  const match = await matchScene(
    userInput,
    provider,
    sceneIndex,
    SCENE_MATCH_THRESHOLD,
    recentMessages,
  );
  const scene: SceneId = match?.scene ?? "";
  if (!scene) {
    // 没命中任何场景，只注入通用语气规则
    return loadToneRules();
  }

  console.log("[ToneInjector] 场景命中: " + scene + " (score=" + (match?.score.toFixed(3) ?? "?") + ")");

  const samples = loadSceneSamples(scene);
  const sampleInstruction = buildSampleInstruction(samples, scene);
  const toneRules = loadToneRules();

  return toneRules + sampleInstruction;
}
