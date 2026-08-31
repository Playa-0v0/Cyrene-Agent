import type { TtsAudioFormat, TtsSessionEvent } from "../../shared/tts-session";

interface StreamingFallbackOptions {
  requestId: string;
  cacheKey: string;
  format: TtsAudioFormat;
  signal: AbortSignal;
  stream: (onChunk: (base64: string) => void) => Promise<Buffer>;
  fallback: () => Promise<Buffer>;
  persist: (audio: Buffer) => void | Promise<void>;
  emit: (event: TtsSessionEvent) => void;
}

/** Runs one stream and guarantees that a failed partial stream is replaced by at most one full fallback. */
export async function runTtsStreamingWithFallback(options: StreamingFallbackOptions): Promise<void> {
  const { requestId, cacheKey, format, signal, emit } = options;
  try {
    const audio = await options.stream((base64) => {
      if (!signal.aborted) emit({ requestId, type: "audio-chunk", base64, format });
    });
    if (signal.aborted) return;
    await options.persist(audio);
    if (!signal.aborted) emit({ requestId, type: "stream-completed", cacheKey, format });
  } catch (streamError) {
    if (signal.aborted) return;
    emit({ requestId, type: "fallback-started" });
    try {
      const audio = await options.fallback();
      if (signal.aborted) return;
      await options.persist(audio);
      if (!signal.aborted) {
        emit({
          requestId,
          type: "fallback-ready",
          base64: audio.toString("base64"),
          cacheKey,
          format,
        });
      }
    } catch (fallbackError) {
      if (signal.aborted) return;
      const first = streamError instanceof Error ? streamError.message : String(streamError);
      const second = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      emit({ requestId, type: "error", message: `流式合成失败（${first}），完整合成回退也失败（${second}）` });
    }
  }
}
