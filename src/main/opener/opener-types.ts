// Opener engine 共享類型。

/** 8 個場景 id（與 manifest packs 的 key 對應）。 */
export type SceneId =
  | "morning" | "late_night" | "idle_daze" | "work_break"
  | "back_from_away" | "rainy_day" | "cold_drop" | "sunny_day";

/** manifest.json 裡的單條文案。 */
export interface ManifestItem {
  id: string;
  text: string;
  audio?: string;           // 相對路徑，如 "morning/m01.wav"；省略時顯示純文字氣泡
  condition?: { hourGte?: number };  // 文案級條件（如 hourGte:10 表示 10 點後才可抽中）
}

/** manifest.json 裡的場景配置。 */
export interface ManifestScene {
  todayFiredFlag: string | null;  // 今日觸發標誌名（同名的互斥，每日重置）；null = 無每日限次
  cooldownMs: number;
  recentAvoidN: number;
  items: ManifestItem[];
}

/** manifest.json 頂層。 */
export interface Manifest {
  version: number;
  packs: Record<string, ManifestScene>;
}

/** 運行時持久化狀態（opener-state.json）。 */
export interface OpenerState {
  globalDesire: number;                       // 0-100
  affinity: Record<string, number>;           // 各場景偏好倍數，初始 1.0，範圍 [0.3, 2.0]
  todayFired: Record<string, boolean>;        // 今日已觸發的標誌
  lastFiredAt: Record<string, number | null>; // 各場景上次觸發時間戳 ms
  recentItems: Record<string, string[]>;      // 各場景最近播過的 item id
  lastTriggeredScene: string | null;          // 供反饋閉環
  lastTriggeredAt: number | null;
  desireRateMultiplier: number;               // 0.5-1.5
  lastDateStr: string;                        // YYYY-MM-DD，跨天檢測用
  dailyFireCount: number;                     // 今日已主動開口次數
}

export interface OpenerRuntimeConfig {
  mode: "quiet" | "normal" | "lively";
  quietStart: string;
  quietEnd: string;
  dailyLimit: number;
  routineEnabled: boolean;
  breaksEnabled: boolean;
  weatherEnabled: boolean;
  city: string;
}

export interface OpenerStatus {
  running: boolean;
  packSource: "voice-pack" | "built-in-text";
  packDir: string;
  sceneCount: number;
  audioItemCount: number;
  textItemCount: number;
  dailyFireCount: number;
  dailyLimit: number;
  desire: number;
  lastScene: string | null;
  lastTriggeredAt: number | null;
  city: string;
}

/** 感知層採集的狀態快照（每 tick 一次）。 */
export interface UserStateSnapshot {
  hour: number;                  // 0-23
  idleSec: number;               // 系統空閒秒數（powerMonitor）
  mouseResumeEvent: boolean;     // 本 tick 是否發生"空閒>30min 後恢復活動"
  lastChatAgoMs: number;         // 距上次對話的毫秒數
  keyboardAccumMin: number;      // 非空閒累計分鐘數（idleSec<60 算活躍，每 tick +1）
}

/** 天氣快照。 */
export interface WeatherSnapshot {
  isRaining: boolean;
  precip: number;
  temp: number;
  tempDropFromYesterday: number;
  isSunny: boolean;
  tempComfortable: boolean;      // 18-26℃
}

/** LIVE2D_SHOW_BUBBLE payload。 */
export interface ShowBubblePayload {
  text: string;
  audioBase64: string;
  format: "wav" | "mp3";
  durationMs: number;
  sceneId: string;
  itemId: string;
}

/** OPENER_FEEDBACK payload。 */
export interface OpenerFeedbackPayload {
  type: "clicked";   // 一期只有"點氣泡"這一種反饋；"忽略"由響應窗口超時內部判定
  sceneId: string;
  itemId: string;
}
