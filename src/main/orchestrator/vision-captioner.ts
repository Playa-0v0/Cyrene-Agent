// vision-captioner —— 唯一接觸多模態協議的地方。
// 通用視覺服務：給圖片+用戶問題→調視覺模型→返回文本。
// 不關心圖片來源（read_image 只是調用者之一），不碰文件系統。
// 永遠走 OpenAI 兼容 image_url 格式，不分 transport。
//
// 判斷全交給視覺模型：不本地判斷"具體vs泛泛"，把用戶原話+圖片一起發，
// 配框架指令讓視覺模型自己理解任務。

/** 視覺模型配置（OpenAI 兼容）。 */
export interface VisionConfig {
  baseUrl: string;  // 如 https://api.openai.com/v1
  apiKey: string;
  model: string;    // 如 gpt-4o / glm-5v-turbo / qwen-vl-max
}

/** 圖片數據（不含 data: 前綴的純 base64）。 */
export interface VisionImage {
  base64: string;
  mime: string;  // 如 "image/png"
}

const VISION_TIMEOUT_MS = 30_000;

/**
 * 構造框架指令。判斷全交給視覺模型——它本身是語言模型，
 * 理解"幾隻貓"是要數數、"有沒有錯別字"是 OCR，比本地正則/分類都準。
 * 指令含簡潔約束，防止長文本回灌撐爆主模型上下文（連續看多圖時尤其關鍵）。
 */
function buildInstruction(userQuery: string): string {
  if (userQuery && userQuery.trim()) {
    return (
      "你是圖片分析助手。用戶給你一張圖，用戶的問題如下：\n" +
      '"' + userQuery + '"\n' +
      "請先基於圖片直接回答用戶的問題，再補充足以供長期記憶的客觀畫面描述：人物外觀（不要猜真實身分）、物件、場景、動作、可見文字與重要細節。不要無依據猜測，總長控制在 350 字內。"
    );
  }
  return (
    "你是圖片分析助手。用戶給你一張圖，但沒有提出具體問題。\n" +
    "請客觀描述這張圖片並留下足以供長期記憶的內容：人物外觀（不要猜真實身分）、主要物體、場景、動作、可見文字和重要細節。不要無依據猜測，描述控制在 350 字以內。"
  );
}

/**
 * 調視覺模型分析圖片。
 * @param image 圖片數據
 * @param userQuery 用戶當前問題；空串表示無明確問題（走通用描述）
 * @param config 視覺模型配置
 * @returns 視覺模型的文本回答；失敗返回 [錯誤·...] 字符串
 */
export async function captionImage(
  image: VisionImage,
  userQuery: string,
  config: VisionConfig,
): Promise<string> {
  const instruction = buildInstruction(userQuery);
  const dataUrl = "data:" + image.mime + ";base64," + image.base64;

  // 永遠 OpenAI 兼容格式：image_url content block
  const body = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    // 不傳 temperature：不同模型約束不同（如 Kimi k2.6 只允許 1），
    // 傳固定值會在某些模型上報錯。讓各家用自己的默認值，可用性優先於確定性。
    // 確定性由 buildInstruction 裡的"簡潔/直接"指令約束保證。
    // 視覺描述用不到 4096 默認值，768 足以保留可搜尋細節且不致撐爆主模型上下文。
    // 只傳 max_tokens（最通用）。不傳 max_completion_tokens——火山不允許兩者同時設，
    // MiniMax 雖標 max_tokens 棄用但仍兼容（棄用≠刪除）。
    max_tokens: 768,
    stream: false,
  };

  const url = buildChatCompletionsUrl(config.baseUrl);

  // 進度信號（實現要求，非可選）：調用期間界面可能"卡住"30s，必須留日誌
  console.log("[Vision] 調用視覺模型:", config.model, "url=" + url, "query.len=" + userQuery.length);
  const startMs = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[Vision] 請求失敗 HTTP " + resp.status, errText.slice(0, 200));
      return "[錯誤·運行時] 視覺模型請求失敗：HTTP " + resp.status + " " + errText.slice(0, 200);
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      console.error("[Vision] 視覺模型未返回有效內容");
      return "[錯誤·運行時] 視覺模型未返回有效內容";
    }

    console.log("[Vision] 完成，耗時=" + (Date.now() - startMs) + "ms，返回長度=" + text.length);
    return text;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[Vision] 請求超時");
      return "[錯誤·運行時] 視覺模型請求超時";
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Vision] 請求異常:", msg);
    return "[錯誤·運行時] 視覺模型請求異常：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 拼接 baseUrl + /chat/completions，兼容用戶填的帶或不帶尾斜槓。 */
function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return trimmed + "/chat/completions";
}
