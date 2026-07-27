// bot-tools —— 引擎依賴注入的工具集合接口。
// 引擎不直接 import screenshot/input/vlm/refs，而通過此接口調用，便於單測 mock。
// 實際實現由 index.ts 組裝（screenshot + input + vlm-locator + refs-store）。

export interface BotTools {
  /** 啟動 exe。 */
  launch(exe: string): Promise<void>;
  /** 依 YAAGL 視窗邊界點擊其主要「開始遊戲」按鈕。 */
  yaaglStart(): Promise<void>;
  /** 截當前屏幕，返回 base64 + 實際像素尺寸。 */
  screenshot(): Promise<{ base64: string; mime: string; width: number; height: number } | null>;
  /** 點擊屏幕座標。 */
  click(x: number, y: number): Promise<void>;
  /** 點擊屏幕中心。 */
  clickCenter(): Promise<void>;
  /** 按組合鍵（如 "F4" / "Alt+F4"）。 */
  key(combo: string): Promise<void>;
  /** 視覺定位：參考圖 + 描述 → 目標座標。未找到返回 null。 */
  locate(refName: string, targetDesc?: string): Promise<{ x: number; y: number } | null>;
  /** 純語義定位（無參考圖，如"列表第一個"）→ 座標。未找到返回 null。 */
  select(desc: string): Promise<{ x: number; y: number } | null>;
  /** 視覺判斷 → 布爾。無法判斷返回 null。 */
  check(ask: string, refName?: string): Promise<boolean | null>;
  /** 多圖比對 → 匹配的參考圖序號（0-based）。無法判斷返回 null。 */
  compare(refNames: string[], ask: string): Promise<number | null>;
}

/** 進度回調：每個頂層步驟執行前調用。 */
export type ProgressCb = (info: { index: number; total: number; desc: string }) => void;
