export interface SharedScreenFrame {
  mime: "image/jpeg" | "image/png";
  base64: string;
}

const MAX_SCREEN_FRAME_LENGTH = 2_500_000;
const SCREEN_REFERENCE = /畫面|螢幕|屏幕|視窗|這個|這裡|看到|看一下|幫我看|看得到|錯誤|問題|怎麼|如何|是什麼|哪裡/;

/** 僅接受有界的 JPEG/PNG data URL，避免 IPC 被任意大字串撐爆。 */
export function parseSharedScreenFrame(dataUrl: unknown): SharedScreenFrame | null {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_SCREEN_FRAME_LENGTH) return null;
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  return { mime: match[1] as SharedScreenFrame["mime"], base64: match[2] };
}

/** 只有用戶提到目前所見內容時才跑視覺模型，避免每輪額外增加通話延遲。 */
export function shouldUseSharedScreen(userText: string): boolean {
  return SCREEN_REFERENCE.test(userText);
}
