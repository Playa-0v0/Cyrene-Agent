// vlm-locator —— 視覺定位調用（OpenAI 兼容多圖協議）。
// 複用 vision-captioner 的協議形態，但 prompt 改為要求返回座標/判斷 JSON，且支持多圖。
// 不復用 vision-captioner 模塊本身（它寫死單圖+通用描述），本模塊是 game-bot 定位專用。

import { parseClickCoord, parseBoolAnswer, parseMatchIndex } from "./coords";

export interface VlmConfig {
  baseUrl: string;  // 如 https://api.siliconflow.cn/v1
  apiKey: string;
  model: string;    // 如 Qwen/Qwen3-VL-8B-Instruct
}

/** 圖片數據（不含 data: 前綴的純 base64 + mime）。 */
export interface ImgData {
  base64: string;
  mime: string;
}

const VLM_TIMEOUT_MS = 30_000;

/** 拼接 baseUrl + /chat/completions，兼容帶或不帶尾斜槓。 */
function chatUrl(baseUrl: string): string {
  const t = baseUrl.trim().replace(/\/+$/, "");
  if (t.endsWith("/chat/completions")) return t;
  return t + "/chat/completions";
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 發一次多圖 chat 請求，返回助手文本。失敗返回空串。 */
async function chat(config: VlmConfig, instruction: string, images: ImgData[]): Promise<string> {
  const content: ContentBlock[] = [{ type: "text", text: instruction }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: "data:" + img.mime + ";base64," + img.base64 } });
  }
  const body = {
    model: config.model,
    messages: [{ role: "user", content }],
    max_tokens: 512,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLM_TIMEOUT_MS);
  try {
    const resp = await fetch(chatUrl(config.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("[GameBot] VLM 請求失敗 HTTP", resp.status, t.slice(0, 200));
      return "";
    }
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    return data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    console.error("[GameBot] VLM 請求異常:", err instanceof Error ? err.message : err);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 定位點擊：參考小圖（目標元素）+ 當前截圖 → 返回目標在當前截圖的屏幕座標。
 * images 順序：先參考圖後當前截圖。screenW/H 用於歸一化轉像素。
 * 未找到或失敗返回 null。
 */
export async function locate(
  config: VlmConfig,
  screenImg: ImgData,
  refImgs: ImgData[],
  targetDesc: string,
  screenW: number,
  screenH: number,
): Promise<{ x: number; y: number } | null> {
  const instruction =
    "以下是參考圖（要找的目標元素）和當前遊戲屏幕截圖。" +
    (targetDesc ? "目標描述：" + targetDesc + "。" : "") +
    "請在當前截圖中找到與參考圖相同或相似的目標元素，返回其中心位置。" +
    "座標系為 0-1000 歸一化（左上 0,0，右下 1000,1000）。" +
    "只返回 JSON：{\"x\":<0-1000>,\"y\":<0-1000>}，不要任何其他文字。";
  // 順序：參考圖在前，當前截圖最後
  const text = await chat(config, instruction, [...refImgs, screenImg]);
  if (!text) return null;
  return parseClickCoord(text, screenW, screenH);
}

/** 狀態判斷：當前截圖（可選參考圖）+ 問題 → 布爾。無法判斷返回 null。 */
export async function check(
  config: VlmConfig,
  screenImg: ImgData,
  ask: string,
  refImg?: ImgData,
): Promise<boolean | null> {
  const instruction =
    ask + "\n只返回 JSON：{\"answer\":true} 或 {\"answer\":false}，不要任何其他文字。";
  const imgs = refImg ? [refImg, screenImg] : [screenImg];
  const text = await chat(config, instruction, imgs);
  if (!text) return null;
  return parseBoolAnswer(text);
}

/** 多圖比對：當前截圖 + 多張參考圖 → 匹配的參考圖序號（0-based）。無法判斷返回 null。 */
export async function compare(
  config: VlmConfig,
  screenImg: ImgData,
  refImgs: ImgData[],
  ask: string,
): Promise<number | null> {
  const instruction =
    ask + "\n參考圖按順序編號 0,1,2...。請找出與當前截圖匹配的參考圖序號。" +
    "只返回 JSON：{\"match\":<序號>}，不要任何其他文字。";
  const text = await chat(config, instruction, [...refImgs, screenImg]);
  if (!text) return null;
  return parseMatchIndex(text, refImgs.length);
}
