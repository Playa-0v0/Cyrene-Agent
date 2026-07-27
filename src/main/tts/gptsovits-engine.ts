// GPT-SoVITS 本地 TTS 引擎
// 接口：官方 api_v2 (POST /api/tts)，返回 wav 字節
// 參考：https://github.com/RVC-Boss/GPT-SoVITS
import * as fs from "fs";

export interface GptsovitsSynthesizeOptions {
  baseUrl: string;          // 形如 "http://localhost:9880"，不含路徑
  refAudioPath: string;     // 參考音頻絕對路徑
  promptText: string;      // 參考音頻對應的文本
  text: string;             // 待合成文本
  speed?: number;           // 0.5~2，默認 1
  format?: "wav" | "mp3";   // 默認 wav
  timeoutMs?: number;      // 默認 60000（本地推理可能較慢）
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface GptsovitsSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = 60000;
const TTS_PATH = "/tts";

/**
 * 調 GPT-SoVITS api_v2。
 * 請求體 application/x-www-form-urlencoded：
 *   refer_wav_path / prompt_text / text / text_language / prompt_language / speed_factor / streaming / format
 * 返回完整 wav（或 mp3）字節。
 */
export async function synthesize(opts: GptsovitsSynthesizeOptions): Promise<GptsovitsSynthesizeResult> {
  const format: "wav" | "mp3" = opts.format ?? "wav";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `gptsovits-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  // 1) 輸入校驗
  if (!opts.baseUrl) throw new Error("缺少 GPT-SoVITS API 地址");
  if (!opts.refAudioPath) throw new Error("缺少參考音頻路徑");
  if (!opts.promptText) throw new Error("缺少參考音頻對應的文本");
  if (!opts.text) throw new Error("缺少合成文本");
  if (!fs.existsSync(opts.refAudioPath)) {
    throw new Error(`參考音頻文件不存在: ${opts.refAudioPath}`);
  }

  // Clean text by stripping parentheses, stage directions, emojis, and music symbols
  const cleanText = (text: string): string => {
    if (!text) return "";
    let val = text;
    val = val.replace(/（[^）]+）/g, "");
    val = val.replace(/\([^)]+\)/g, "");
    val = val.replace(/\[[^\]]+\]/g, "");
    val = val.replace(/\*[^*]+\*/g, "");
    val = val.replace(/[\u{1F300}-\u{1F9FF}]/gu, "");
    val = val.replace(/[\u{2700}-\u{27BF}]/gu, "");
    val = val.replace(/[♪★☆♥♦♣♠♫♬💕✨🌟🎨🎭🎪🎫🎗🏵🎫🎟🎮🎲🎰🎯🎳🎱🎵🎶🎙🎛🎤🎧🎷🎸🎹🎺🎻🥁]/g, "");
    val = val.replace(/\s+/g, " ");
    return val.trim();
  };

  const cleanedText = cleanText(opts.text);

  // 2) 構造 JSON body（裸對象，不包 data）
  // 契約參考 GPT-SoVITS api_v2.py: POST /tts，body 是 TTS_Request 模型
  // 必需字段：text / text_lang / ref_audio_path / prompt_lang
  const body = JSON.stringify({
    text: cleanedText,
    text_lang: "zh",
    ref_audio_path: opts.refAudioPath,
    prompt_text: opts.promptText,
    prompt_lang: "zh",
    speed_factor: opts.speed ?? 1,
    streaming_mode: false,
    media_type: format,
  });

  // baseUrl 去掉尾部斜槓，拼 /api/tts
  const url = opts.baseUrl.replace(/\/+$/, "") + TTS_PATH;

  log({
    phase: "request.begin",
    endpoint: url,
    textChars: Array.from(opts.text).length,
    refAudioPath: opts.refAudioPath,
    format,
  });

  // 3) 發請求 + 超時控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log({ phase: "error", error: `合成超時（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`GPT-SoVITS 合成超時（${timeoutMs}ms），檢查服務是否在跑`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`GPT-SoVITS 請求失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  // 4) 響應處理
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const preview = text.slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`GPT-SoVITS 合成失敗: ${resp.status} ${preview}`);
  }

  const audio = Buffer.from(await resp.arrayBuffer());

  // 校驗 magic bytes：wav 以 "RIFF" 開頭，mp3 以 ID3 或 0xFF 0xFB 開頭
  const isWav = audio.slice(0, 4).toString("ascii") === "RIFF";
  const isMp3 = audio[0] === 0x49 /* I (ID3) */ || audio[0] === 0xff;
  if (format === "wav" && !isWav && !isMp3) {
    log({ phase: "warn", message: "期望 wav 但返回的不是 RIFF 頭", firstBytes: audio.slice(0, 4).toString("hex") });
  }

  log({
    phase: "response.final",
    durationMs: Date.now() - startedAt,
    audioBytes: audio.length,
    isWav,
    isMp3,
  });

  return { audio, format };
}
