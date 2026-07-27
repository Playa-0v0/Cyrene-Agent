// 主進程內的 TTS 引擎分發。僅 call-manager 調用（不經 IPC）。
// chat/main.ts 走兩個獨立 IPC 通道，不用這個 dispatcher。

import { synthesize as minimaxSynthesize } from "./minimax-engine";
import { synthesize as gptsovitsSynthesize } from "./gptsovits-engine";
import { synthesize as customCloudSynthesize } from "./custom-cloud-engine";
import { synthesize as mimoSynthesize } from "./mimo-engine";
import type { TtsEngine } from "../../shared/tts-types";

export interface SynthesizeByEnginePayload {
  text: string;
  speed?: number;
  volume?: number;
  // minimax 專用
  apiKey?: string;
  voiceId?: string;
  model?: string;
  // gptsovits 專用
  baseUrl?: string;
  refAudioPath?: string;
  promptText?: string;
  format?: "wav" | "mp3";
  // custom-cloud 專用
  endpointUrl?: string;
  timeoutMs?: number;
  // mimo 專用
  voiceAudioPath?: string;
  stylePrompt?: string;
}

export interface SynthesizeByEngineResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

/**
 * 按 engine 分發到對應引擎合成。
 * 通話 TTS 不走緩存（實時性優先）。
 * engine === "off" 時拋錯。
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
      format: "mp3",
    });
    return { audio, format: "mp3" };
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
      throw new Error("自定義雲端 TTS 未配置 endpointUrl");
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
      throw new Error("MiMo TTS 未配置 apiKey/克隆音頻");
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

  throw new Error(`TTS 引擎未啟用（engine=${engine}）`);
}
