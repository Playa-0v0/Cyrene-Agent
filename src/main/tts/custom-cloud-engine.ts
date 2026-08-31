// 自定义云端 TTS 引擎
// 固定 HTTP 合约：POST endpointUrl，返回音频二进制或 JSON base64。

import { resolveTimeoutPolicy } from "../runtime-policy";

export interface CustomCloudSynthesizeOptions {
  endpointUrl: string;
  apiKey?: string;
  voiceId?: string;
  text: string;
  speed?: number;
  volume?: number;
  format?: "wav" | "mp3";
  timeoutMs?: number;
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface CustomCloudSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = resolveTimeoutPolicy({ stage: "tts-custom-cloud" }).totalMs;

function normalizeFormat(value: unknown, fallback: "wav" | "mp3"): "wav" | "mp3" {
  return value === "wav" || value === "mp3" ? value : fallback;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

function guessFormatFromContentType(contentType: string, fallback: "wav" | "mp3"): "wav" | "mp3" {
  const lower = contentType.toLowerCase();
  if (lower.includes("wav") || lower.includes("wave")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  return fallback;
}

export async function synthesize(opts: CustomCloudSynthesizeOptions): Promise<CustomCloudSynthesizeResult> {
  const endpointUrl = opts.endpointUrl?.trim();
  const text = opts.text?.trim();
  const format = opts.format ?? "mp3";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `custom-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  if (!endpointUrl) throw new Error("缺少自定义云端 TTS 地址");
  if (!text) throw new Error("缺少合成文本");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = opts.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  log({
    phase: "request.begin",
    endpoint: endpointUrl,
    textChars: Array.from(text).length,
    format,
    timeoutMs,
  });

  let resp: Response;
  try {
    resp = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        voiceId: opts.voiceId?.trim() || undefined,
        speed: opts.speed ?? 1,
        volume: opts.volume ?? 1,
        format,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log({ phase: "error", error: `合成超时（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`自定义云端 TTS 合成超时（${timeoutMs}ms）`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`自定义云端 TTS 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const preview = (await resp.text().catch(() => "")).slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`自定义云端 TTS 合成失败: ${resp.status} ${preview}`.trim());
  }

  const contentType = resp.headers.get("Content-Type") ?? "";
  let audio: Buffer;
  let resultFormat = guessFormatFromContentType(contentType, format);

  if (isJsonContentType(contentType)) {
    const data = (await resp.json()) as {
      audioBase64?: unknown;
      format?: unknown;
    };
    if (typeof data.audioBase64 !== "string" || !data.audioBase64.trim()) {
      throw new Error("自定义云端 TTS 响应缺少 audioBase64");
    }
    audio = Buffer.from(data.audioBase64, "base64");
    resultFormat = normalizeFormat(data.format, format);
  } else {
    audio = Buffer.from(await resp.arrayBuffer());
  }

  if (audio.length === 0) {
    throw new Error("自定义云端 TTS 返回空音频");
  }

  log({
    phase: "response.final",
    durationMs: Date.now() - startedAt,
    audioBytes: audio.length,
    format: resultFormat,
  });

  return { audio, format: resultFormat };
}
