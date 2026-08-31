import { app } from "electron";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { type TtsAudioFormat } from "../../shared/tts-session";
import { DEFAULT_MOSSLAND_TTS_MODEL } from "../../shared/tts-types";

export function appendMinimaxTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "minimax-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[TTS MiniMax] 写诊断日志失败:", err);
  }
}

export function appendGptsovitsTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "gptsovits-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[TTS GPT-SoVITS] 写诊断日志失败:", err);
  }
}

export function appendCustomCloudTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "custom-cloud-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[TTS CustomCloud] 写诊断日志失败:", err);
  }
}

export function appendMimoTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "mimo-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[TTS MiMo] 写诊断日志失败:", err);
  }
}

export function getTtsCacheDir(): string {
  return path.join(app.getPath("userData"), "cyrene-tts-cache");
}

export function assertTtsCacheKey(cacheKey: string): string {
  if (!/^(minimax|gptsovits|custom-cloud|mimo|mossland)-[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error("非法 TTS 缓存 key");
  }
  return cacheKey;
}

export function buildTtsCacheKey(payload: {
  voiceId: string;
  text: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  model?: string;
  format?: "mp3" | "wav" | "pcm";
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "minimax",
    model: payload.model ?? "speech-2.8-hd",
    voiceId: payload.voiceId,
    speed: payload.speed ?? 1,
    volume: payload.volume ?? 1,
    pitch: payload.pitch ?? 0,
    format: payload.format ?? "mp3",
    text: payload.text,
  });
  return "minimax-" + createHash("sha256").update(source, "utf8").digest("hex");
}

export function buildGptsovitsCacheKey(payload: {
  baseUrl: string;
  refAudioPath: string;
  promptText: string;
  text: string;
  speed?: number;
  format?: "wav" | "mp3";
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "gptsovits",
    baseUrl: payload.baseUrl,
    refAudioPath: payload.refAudioPath,
    promptText: payload.promptText,
    speed: payload.speed ?? 1,
    format: payload.format ?? "wav",
    text: payload.text,
  });
  return "gptsovits-" + createHash("sha256").update(source, "utf8").digest("hex");
}

export function buildCustomCloudCacheKey(payload: {
  endpointUrl: string;
  voiceId?: string;
  text: string;
  speed?: number;
  volume?: number;
  format?: "wav" | "mp3";
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "custom-cloud",
    endpointUrl: payload.endpointUrl,
    voiceId: payload.voiceId ?? "",
    speed: payload.speed ?? 1,
    volume: payload.volume ?? 1,
    format: payload.format ?? "mp3",
    text: payload.text,
  });
  return "custom-cloud-" + createHash("sha256").update(source, "utf8").digest("hex");
}

export function buildMimoCacheKey(payload: {
  voiceAudioPath?: string;
  text: string;
  stylePrompt?: string;
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "mimo",
    model: "mimo-v2.5-tts-voiceclone",
    voiceAudioPath: payload.voiceAudioPath ?? "",
    stylePrompt: payload.stylePrompt ?? "",
    format: "wav",
    text: payload.text,
  });
  return "mimo-" + createHash("sha256").update(source, "utf8").digest("hex");
}

/** Mossland cache key：voice_id + model + format + text 哈希。
 *  因为 Mossland 没有"参考音频路径"作为天然 key 源，用 voice_id + model 区分。 */
export function buildMosslandCacheKey(payload: {
  voiceId?: string;
  text: string;
  model?: string;
  format?: "mp3" | "wav" | "pcm";
}): string {
  const source = JSON.stringify({
    version: 2,
    engine: "mossland",
    model: payload.model ?? DEFAULT_MOSSLAND_TTS_MODEL,
    voiceId: payload.voiceId ?? "",
    format: payload.format ?? "mp3",
    text: payload.text,
  });
  return "mossland-" + createHash("sha256").update(source, "utf8").digest("hex");
}

export function readTtsCacheByKey(cacheKey: string): { audio: Buffer; format: TtsAudioFormat } | null {
  for (const format of ["mp3", "wav", "pcm"] as const) {
    let cachePath: string;
    try {
      cachePath = getTtsCachePath(cacheKey, format);
    } catch {
      return null;
    }
    if (fs.existsSync(cachePath)) return { audio: fs.readFileSync(cachePath), format };
  }
  return null;
}

export function getTtsCachePath(cacheKey: string, format: "mp3" | "wav" | "pcm" = "mp3"): string {
  const safeKey = assertTtsCacheKey(cacheKey);
  const ext = format === "wav" ? "wav" : format === "pcm" ? "pcm" : "mp3";
  return path.join(getTtsCacheDir(), `${safeKey}.${ext}`);
}
