// TTS 引擎共享类型（main / renderer 共用）。

export type TtsEngine = "off" | "minimax" | "gptsovits";

/** GPT-SoVITS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface GptsovitsSynthesizeRequest {
  baseUrl: string;             // 形如 "http://localhost:9880"，不含路径
  refAudioPath: string;        // 参考音频绝对路径
  promptText: string;          // 参考音频对应的文本
  text: string;                // 待合成文本
  speed?: number;              // 0.5~2，默认 1
  format?: "wav" | "mp3";      // 默认 wav
}

/** TTS 合成返回（主进程 → 渲染端 IPC 返回）。minimax 和 gptsovits 共用。 */
export interface TtsSynthesizeResult {
  base64: string;              // 音频字节 base64
  cacheKey: string;            // 缓存 key（用于回听）
  cached: boolean;             // 是否命中缓存
  format: "wav" | "mp3";       // 实际返回的音频格式
}
