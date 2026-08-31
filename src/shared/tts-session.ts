export type TtsAudioFormat = "mp3" | "wav" | "pcm";

export interface StartTtsRequest {
  requestId: string;
  conversationId: string;
  messageId: string;
  speechText: string;
  converterVersion: string;
  automatic?: boolean;
  supportsStreamingPlayback?: boolean;
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
