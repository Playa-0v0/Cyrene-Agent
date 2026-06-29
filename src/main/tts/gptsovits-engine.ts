// GPT-SoVITS 本地 TTS 引擎
// 接口：官方 api_v2 (POST /api/tts)，返回 wav 字节
// 参考：https://github.com/RVC-Boss/GPT-SoVITS
import * as fs from "fs";

export interface GptsovitsSynthesizeOptions {
  baseUrl: string;          // 形如 "http://localhost:9880"，不含路径
  refAudioPath: string;     // 参考音频绝对路径
  promptText: string;      // 参考音频对应的文本
  text: string;             // 待合成文本
  speed?: number;           // 0.5~2，默认 1
  format?: "wav" | "mp3";   // 默认 wav
  timeoutMs?: number;      // 默认 60000（本地推理可能较慢）
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface GptsovitsSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = 60000;
const TTS_PATH = "/api/tts";

/**
 * 调 GPT-SoVITS api_v2。
 * 请求体 application/x-www-form-urlencoded：
 *   refer_wav_path / prompt_text / text / text_language / prompt_language / speed_factor / streaming / format
 * 返回完整 wav（或 mp3）字节。
 */
export async function synthesize(opts: GptsovitsSynthesizeOptions): Promise<GptsovitsSynthesizeResult> {
  const format: "wav" | "mp3" = opts.format ?? "wav";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `gptsovits-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  // 1) 输入校验
  if (!opts.baseUrl) throw new Error("缺少 GPT-SoVITS API 地址");
  if (!opts.refAudioPath) throw new Error("缺少参考音频路径");
  if (!opts.promptText) throw new Error("缺少参考音频对应的文本");
  if (!opts.text) throw new Error("缺少合成文本");
  if (!fs.existsSync(opts.refAudioPath)) {
    throw new Error(`参考音频文件不存在: ${opts.refAudioPath}`);
  }

  // 2) 构造 JSON body（GPT-SoVITS api_v2 用 FastAPI/Pydantic，期望 application/json）
  const body = JSON.stringify({
    refer_wav_path: opts.refAudioPath,
    prompt_text: opts.promptText,
    text: opts.text,
    text_lang: "中英混合",
    prompt_lang: "中英混合",
    speed_factor: opts.speed ?? 1,
    streaming: false,
    format: format,
  });

  // baseUrl 去掉尾部斜杠，拼 /api/tts
  const url = opts.baseUrl.replace(/\/+$/, "") + TTS_PATH;

  log({
    phase: "request.begin",
    endpoint: url,
    textChars: Array.from(opts.text).length,
    refAudioPath: opts.refAudioPath,
    format,
  });

  // 3) 发请求 + 超时控制
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
      log({ phase: "error", error: `合成超时（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`GPT-SoVITS 合成超时（${timeoutMs}ms），检查服务是否在跑`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`GPT-SoVITS 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  // 4) 响应处理
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const preview = text.slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`GPT-SoVITS 合成失败: ${resp.status} ${preview}`);
  }

  const audio = Buffer.from(await resp.arrayBuffer());

  // 校验 magic bytes：wav 以 "RIFF" 开头，mp3 以 ID3 或 0xFF 0xFB 开头
  const isWav = audio.slice(0, 4).toString("ascii") === "RIFF";
  const isMp3 = audio[0] === 0x49 /* I (ID3) */ || audio[0] === 0xff;
  if (format === "wav" && !isWav && !isMp3) {
    log({ phase: "warn", message: "期望 wav 但返回的不是 RIFF 头", firstBytes: audio.slice(0, 4).toString("hex") });
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
