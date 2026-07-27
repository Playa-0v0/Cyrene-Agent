// coords —— VLM 文本 → 座標/布爾/匹配索引 解析。
// 純函數，不依賴 electron。VLM 返回 JSON（可能帶 ```json 圍欄或夾在文本里），
// 統一要求座標為 0-1000 歸一化，不依賴各模型私有格式。

/** 從文本提取首個 JSON 對象並解析。失敗返回 null。 */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/gi, "").trim();
  try {
    const v = JSON.parse(cleaned);
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const v = JSON.parse(cleaned.slice(start, end + 1));
      return v && typeof v === "object" ? v as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

/** VLM 文本 → 點擊座標（0-1000 歸一化 → 屏幕像素，clamp 邊界）。無座標返回 null。 */
export function parseClickCoord(text: string, screenW: number, screenH: number): { x: number; y: number } | null {
  const obj = extractJson(text);
  if (!obj) return null;
  const x = Number(obj.x);
  const y = Number(obj.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const px = Math.max(0, Math.min(screenW, Math.round((x / 1000) * screenW)));
  const py = Math.max(0, Math.min(screenH, Math.round((y / 1000) * screenH)));
  return { x: px, y: py };
}

/** VLM 文本 → 布爾（vlm_check 用）。JSON {answer:bool} 優先；否則中文/英文關鍵詞。無法判斷 null。 */
export function parseBoolAnswer(text: string): boolean | null {
  const obj = extractJson(text);
  if (obj && typeof obj.answer === "boolean") return obj.answer;
  // false 關鍵詞優先（"沒有"含"有"但整體應是 false）
  if (/無|沒|否|不|未|關|false|no/i.test(text)) return false;
  if (/是|有|開|true|yes/i.test(text)) return true;
  return null;
}

/** VLM 文本 → 匹配索引（vlm_compare 用）。{match:index}；索引超 [0,refCount) 返回 null。 */
export function parseMatchIndex(text: string, refCount: number): number | null {
  const obj = extractJson(text);
  if (!obj) return null;
  const idx = Number(obj.match);
  if (!Number.isFinite(idx)) return null;
  const i = Math.round(idx);
  if (i < 0 || i >= refCount) return null;
  return i;
}
