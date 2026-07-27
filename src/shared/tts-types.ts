// TTS 引擎共享類型（main / renderer 共用）。

export type TtsEngine = "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo";

/** GPT-SoVITS 合成請求（渲染端 → 主進程 IPC payload）。 */
export interface GptsovitsSynthesizeRequest {
  baseUrl: string;             // 形如 "http://localhost:9880"，不含路徑
  refAudioPath: string;        // 參考音頻絕對路徑
  promptText: string;          // 參考音頻對應的文本
  text: string;                // 待合成文本
  speed?: number;              // 0.5~2，默認 1
  format?: "wav" | "mp3";      // 默認 wav
}

/** 自定義雲端 TTS 合成請求（渲染端 → 主進程 IPC payload）。 */
export interface CustomCloudSynthesizeRequest {
  endpointUrl: string;          // 用戶自建雲端 TTS endpoint
  apiKey?: string;              // 可選；為空時不發送 Authorization
  voiceId?: string;             // 可選音色 ID，透傳給用戶雲端網關
  text: string;                 // 待合成文本
  speed?: number;               // 0.5~2，默認 1
  volume?: number;              // 0~1，默認 1
  format?: "wav" | "mp3";       // 默認 mp3
  timeoutMs?: number;           // 默認 30000
}

/** 小米 MiMo TTS 合成請求（渲染端 → 主進程 IPC payload）。 */
export interface MimoSynthesizeRequest {
  apiKey: string;               // 小米 MiMo API Key，走 api-key header
  text: string;                 // 待合成文本
  voiceAudioPath?: string;      // 昔漣克隆參考音頻路徑，合成時轉 data URL
  stylePrompt?: string;         // 可選風格提示，作為 user message
}

/** TTS 合成返回（主進程 → 渲染端 IPC 返回）。minimax 和 gptsovits 共用。 */
export interface TtsSynthesizeResult {
  base64: string;              // 音頻字節 base64
  cacheKey: string;            // 緩存 key（用於回聽）
  cached: boolean;             // 是否命中緩存
  format: "wav" | "mp3";       // 實際返回的音頻格式
}
