// 主进程内的 TTS 引擎分发。仅 call-manager 调用（不经 IPC）。
// chat/main.ts 走两个独立 IPC 通道，不用这个 dispatcher。

import { synthesize as minimaxSynthesize } from "./minimax-engine";
import { synthesize as gptsovitsSynthesize } from "./gptsovits-engine";
import { synthesize as customCloudSynthesize } from "./custom-cloud-engine";
import { synthesize as mimoSynthesize } from "./mimo-engine";
import { synthesize as mosslandSynthesize } from "./mossland-engine";
import type { TtsEngine } from "../../shared/tts-types";

export interface SynthesizeByEnginePayload {
  text: string;
  speed?: number;
  volume?: number;
  // minimax 专用
  apiKey?: string;
  voiceId?: string;
  model?: string;
  // gptsovits 专用
  baseUrl?: string;
  refAudioPath?: string;
  promptText?: string;
  format?: "wav" | "mp3";
  // custom-cloud 专用
  endpointUrl?: string;
  timeoutMs?: number;
  // mimo 专用
  voiceAudioPath?: string;
  stylePrompt?: string;
  // mossland 专用（与 minimax 字段重叠：apiKey/voiceId/model/format，新增 format 选项 pcm）
  mosslandFormat?: "mp3" | "wav" | "pcm";
}

export interface SynthesizeByEngineResult {
  audio: Buffer;
  format: "wav" | "mp3" | "pcm";
}

/**
 * 按 engine 分发到对应引擎合成。
 * 通话 TTS 不走缓存（实时性优先）。
 * engine === "off" 时抛错。
 */
export async function synthesizeByEngine(
  engine: TtsEngine,
  payload: SynthesizeByEnginePayload,
): Promise<SynthesizeByEngineResult> {
  if (engine === "minimax") {
    if (!payload.apiKey || !payload.voiceId) {
      throw new Error("MiniMax TTS 未配置 apiKey/voiceId");
    }
    const audio = await minimaxSynthesize({
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      model: payload.model ?? "speech-2.8-turbo",
      format: payload.format ?? "mp3",
    });
    return { audio, format: payload.format ?? "mp3" };
  }

  if (engine === "gptsovits") {
    if (!payload.baseUrl || !payload.refAudioPath || !payload.promptText) {
      throw new Error("GPT-SoVITS TTS 未配置 baseUrl/refAudioPath/promptText");
    }
    const result = await gptsovitsSynthesize({
      baseUrl: payload.baseUrl,
      refAudioPath: payload.refAudioPath,
      promptText: payload.promptText,
      text: payload.text,
      speed: payload.speed,
      format: payload.format ?? "wav",
    });
    return { audio: result.audio, format: result.format };
  }

  if (engine === "custom-cloud") {
    if (!payload.endpointUrl) {
      throw new Error("自定义云端 TTS 未配置 endpointUrl");
    }
    const result = await customCloudSynthesize({
      endpointUrl: payload.endpointUrl,
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      format: payload.format ?? "mp3",
      timeoutMs: payload.timeoutMs,
    });
    return { audio: result.audio, format: result.format };
  }

  if (engine === "mimo") {
    if (!payload.apiKey || !payload.voiceAudioPath) {
      throw new Error("MiMo TTS 未配置 apiKey/克隆音频");
    }
    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt ?? payload.promptText,
      model: "mimo-v2.5-tts-voiceclone",
    });
    return { audio: result.audio, format: result.format };
  }

  if (engine === "mossland") {
    if (!payload.apiKey || !payload.voiceId) {
      throw new Error("Mossland TTS 未配置 apiKey/voiceId");
    }
    const format = payload.mosslandFormat ?? "mp3";
    const result = await mosslandSynthesize({
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      model: payload.model ?? "moss-tts",
      format,
    });
    return { audio: result.audio, format: result.format };
  }

  throw new Error(`TTS 引擎未启用（engine=${engine}）`);
}
