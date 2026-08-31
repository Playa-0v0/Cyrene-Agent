export type TtsAudioFormat = "mp3" | "wav" | "pcm";

export interface StartTtsRequest {
  requestId: string;
  conversationId: string;
  messageId: string;
  speechText: string;
  converterVersion: string;
  automatic?: boolean;
  supportsStreamingPlayback?: boolean;
  /** 跳过按消息记录读取的历史缓存（分段朗读等文本与消息缓存身份不一致的场景使用）。 */
  bypassMessageCache?: boolean;
}

export type TtsStartResult =
  | { requestId: string; status: "ready"; base64: string; cacheKey: string; format: TtsAudioFormat; cached: boolean }
  | { requestId: string; status: "streaming"; cacheKey: string; format: TtsAudioFormat }
  | { requestId: string; status: "skipped" | "cancelled" };

export type TtsSessionEvent =
  | { requestId: string; type: "audio-chunk"; base64: string; format: TtsAudioFormat }
  | { requestId: string; type: "stream-completed"; cacheKey: string; format: TtsAudioFormat }
  | { requestId: string; type: "fallback-started" }
  | { requestId: string; type: "fallback-ready"; base64: string; cacheKey: string; format: TtsAudioFormat }
  | { requestId: string; type: "error"; message: string };
