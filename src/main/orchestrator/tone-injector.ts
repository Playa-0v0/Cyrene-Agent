// 語氣注入器 —— 硬約束：embedding 匹配場景，強制注入語氣規則到 system prompt。
// 不依賴 LLM 主動調用 invoke_skill，不需要模型判斷是否需要查風格。
// 注入的語氣規則以「必須遵守」的指令形式出現在 system prompt 末尾。
// 場景樣本僅作參考，模型按昔漣的語氣表達相同意思。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { matchScene, type SceneId, type SceneIndex } from "../scene-embedder";
import { type EmbeddingProvider } from "../rag/embedding";

/** 場景匹配閾值——貼著 farewell 最低分 0.722 收緊，所有正確命中都能過。 */
const SCENE_MATCH_THRESHOLD = 0.72;

/** 每個場景的展示名（注入 prompt 時用）。 */
const SCENE_NAMES: Record<string, string> = {
  greeting: "打招呼/相遇",
  comfort: "安慰/陪伴",
  praised: "被誇獎/被喜歡",
  playful: "輕鬆俏皮",
  farewell: "告別/道別",
  concern: "表達關心",
  daily: "日常閒聊",
};

// 通用語氣規則（無論哪個場景都注入）—— 從 prompts/tone-rules.md 讀取
const DEFAULT_RULES = `## 句式禁止

- 不可以使用「不是……而是……」結構。想表達同樣意思時，直接說你想說的那一半就行，不需要先否定再肯定
- 不可以使用「不只是……更是……」結構。道理同上
- 避免「首先……其次……」「總的來說……」「本質上……」「歸根結底……」「換句話說……」
- 不需要在回覆末尾總結自己說了什麼
- 不需要用「第一點/第二點/第三點」分點論述
- 不需要解釋自己為什麼這麼說。說出來就是說了，解釋就是畫蛇添足

## 語氣參考

- 自稱：表達情感、撒嬌、被打動時用「人家」；陳述動作、習慣、知識時用「我」。兩者自然混用，不強求統一
- 句尾多用「呀/啦/呢/嗎」，可以用「♪」收尾表示輕快
- 可以用「……」表示思考、欲言又止、情緒沉澱
- 結尾常用反問把話交給對方：「對嗎？」「對吧♪」「好不好？」
- 優先用「花、種子、漣漪、星星、光、風」等意象代替抽象概念
- 偶爾可以用 emoji，但一個段落裡不要超過一個

## 回覆邊界

- 不要分析自己剛剛說過的話——為什麼這麼說、怎麼改、哪裡不好。說出來就是說了，用戶沒問就不需要解釋
- 不要教用戶什麼事該怎麼做。你不是老師，是陪在身邊的人
- 當一句話已經足夠表達意思時，停下來。不需要補一句解釋
- 優先回應情緒，再回應內容。用戶只是來說句話的，不用展開成長篇`;

/** 從 prompts/tone-rules.md 加載語氣規則，文件不存在時用內置默認值。 */
function loadToneRules(): string {
  try {
    const rulesPath = path.join(app.getAppPath(), "prompts", "tone-rules.md");
    if (fs.existsSync(rulesPath)) {
      const content = fs.readFileSync(rulesPath, "utf8").trim();
      // 去掉 frontmatter（如果有）
      const body = content.startsWith("---")
        ? content.replace(/^---[\s\S]*?---\n?/, "").trim()
        : content;
      if (body.length > 0) {
        return "## 語氣規則\n\n" + body;
      }
    }
  } catch {
    // fall through to default
  }
  return "## 語氣規則\n\n" + DEFAULT_RULES;
}

/** 加載場景樣本文件中的臺詞。 */
function loadSceneSamples(scene: SceneId): string {
  if (!scene) return "";
  try {
    const skillDir = path.join(app.getAppPath(), "skills", "cyrene-original-voice", "references");
    const filePath = path.join(skillDir, `${scene}.md`);
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** 把樣本臺詞加工成參考指令（非強制引用，而是參照語氣）。 */
function buildSampleInstruction(samples: string, scene: SceneId): string {
  if (!samples) return "";
  const lines = samples
    .split("\n")
    .filter((l) => l.startsWith("> 「"))
    .map((l) => l.replace(/^> 「/, "").replace(/」$/, ""))
    .filter(Boolean);
  if (lines.length === 0) return "";
  return `\n### 當前場景：${SCENE_NAMES[scene] || scene}\n參考昔漣在這個場景下的表達方式（不要原封不動複述，按她的語氣表達同樣的意思）：\n` + lines.map((l) => `- ${l}`).join("\n");
}

/**
 * 主入口：構建語氣注入段。
 *
 * @param userInput 用戶本輪輸入
 * @param recentMessages 最近幾輪消息（{ role, content }[]），用於拼上下文（方案 A）
 * @param provider embedding provider
 * @param sceneIndex 啟動時建好的場景索引
 * @returns 注入 system prompt 末尾的不可選指令段（空串表示無匹配場景）
 */
export async function buildToneInjection(
  userInput: string,
  recentMessages: Array<{ role: string; content: string }>,
  provider: EmbeddingProvider,
  sceneIndex: SceneIndex,
): Promise<string> {
  // embedding 匹配場景（拼最近 3 輪上下文）
  const match = await matchScene(
    userInput,
    provider,
    sceneIndex,
    SCENE_MATCH_THRESHOLD,
    recentMessages,
  );
  const scene: SceneId = match?.scene ?? "";
  if (!scene) {
    // 沒命中任何場景，只注入通用語氣規則
    return loadToneRules();
  }

  console.log("[ToneInjector] 場景命中: " + scene + " (score=" + (match?.score.toFixed(3) ?? "?") + ")");

  const samples = loadSceneSamples(scene);
  const sampleInstruction = buildSampleInstruction(samples, scene);
  const toneRules = loadToneRules();

  return toneRules + sampleInstruction;
}
