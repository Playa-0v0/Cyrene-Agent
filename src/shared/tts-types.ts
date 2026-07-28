// TTS 引擎共享类型（main / renderer 共用）。

export type TtsEngine = "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo" | "mossland";

/** GPT-SoVITS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface GptsovitsSynthesizeRequest {
  baseUrl: string;             // 形如 "http://localhost:9880"，不含路径
  refAudioPath: string;        // 参考音频绝对路径
  promptText: string;          // 参考音频对应的文本
  text: string;                // 待合成文本
  speed?: number;              // 0.5~2，默认 1
  format?: "wav" | "mp3";      // 默认 wav
}

/** 自定义云端 TTS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface CustomCloudSynthesizeRequest {
  endpointUrl: string;          // 用户自建云端 TTS endpoint
  apiKey?: string;              // 可选；为空时不发送 Authorization
  voiceId?: string;             // 可选音色 ID，透传给用户云端网关
  text: string;                 // 待合成文本
  speed?: number;               // 0.5~2，默认 1
  volume?: number;              // 0~1，默认 1
  format?: "wav" | "mp3";       // 默认 mp3
  timeoutMs?: number;           // 默认 30000
}

/** 小米 MiMo TTS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface MimoSynthesizeRequest {
  apiKey: string;               // 小米 MiMo API Key，走 api-key header
  text: string;                 // 待合成文本
  voiceAudioPath?: string;      // 昔涟克隆参考音频路径，合成时转 data URL
  stylePrompt?: string;         // 可选风格提示，作为 user message
}

/** Mossland TTS 合成请求（渲染端 → 主进程 IPC payload）。
 *  Base URL 固定 https://api.mosi.cn/v1，引擎在 main 进程硬编码；
 *  用户只需提供 apiKey + 已克隆的 voiceId + 文本。 */
export interface MosslandSynthesizeRequest {
  apiKey: string;               // Bearer token
  voiceId: string;              // 必填：clone 得到的 voice_id
  text: string;                 // 待合成文本
  speed?: number;               // 0.5~2，默认 1
  volume?: number;              // 0~1，默认 1
  model?: string;               // 默认 "moss-tts"；暂不支持 moss-ttsd（多说话人）
  format?: "mp3" | "wav" | "pcm";  // 默认 "mp3"
}

/** Mossland 音色克隆请求（multipart/form-data 上传到 POST /v1/audio/voices）。 */
export interface MosslandCloneRequest {
  apiKey: string;
  filePath: string;             // 本地音频绝对路径，main 进程读取后 multipart
  name?: string;                // 可选，给音色起名
  description?: string;         // 可选，描述音色
}

/** Mossland 克隆返回。 */
export interface MosslandCloneResult {
  voiceId: string;              // 服务端返回的 id
  name?: string;
  createdAt?: number;           // Unix 秒
}

/** Mossland 音色列表里的一条。 */
export interface MosslandVoiceInfo {
  id: string;                   // voice_id
  name: string;
  createdAt: number;            // Unix 秒
}

/** Mossland 拉取音色列表返回。 */
export interface MosslandListVoicesResult {
  voices: MosslandVoiceInfo[];
}

/** TTS 合成返回（主进程 → 渲染端 IPC 返回）。minimax 和 gptsovits 共用。 */
export interface TtsSynthesizeResult {
  base64: string;              // 音频字节 base64
  cacheKey: string;            // 缓存 key（用于回听）
  cached: boolean;             // 是否命中缓存
  format: "wav" | "mp3" | "pcm"; // 实际返回的音频格式；mossland 可能是 pcm
}
