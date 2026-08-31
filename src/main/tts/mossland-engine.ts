// Mossland TTS 引擎（api.mosi.cn / Mossland 云端）。
//
// 第二步接通的功能：
//   - synthesize()      POST /v1/audio/speech       单说话人同步合成（delivery_method=audio → binary）
//   - streamSynthesize() POST /v1/audio/speech      TTS 1.5 Flash PCM/SSE 流式合成
//   - cloneVoice()      POST /v1/audio/voices       multipart/form-data 上传参考音频，返回 voice_id
//   - listVoices()      GET  /v1/audio/voices       拉取账号下已克隆的 voice_id 列表
//
// 暂不实现的功能（按用户决策）：
//   - 多说话人模型 moss-ttsd（POST /v1/audio/speech/speakers）
//   - voice-generator 模型（POST /v1/audio/voice/generations）
//   - async / webhook（同步 delivery_method=audio 足够 Settings 测试发音 + chat 自动朗读）
//
// 错误处理：Mossland 错误响应是 JSON { error: { message, type, param, code } }，
// 我们按 `code` 映射到中文友好消息，HTTP 5xx 直接抛服务端异常。

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveTimeoutPolicy } from "../runtime-policy";
import {
  buildMosslandError,
  MOSSLAND_BASE_URL,
  mosslandFetch,
} from "../mossland/api-client";
import { DEFAULT_MOSSLAND_TTS_MODEL, type MosslandSyncFormat } from "../../shared/tts-types";
import { consumeMosslandSse, type MosslandPcmStreamInfo } from "./mossland-stream";

const BASE_URL = MOSSLAND_BASE_URL;
const DEFAULT_TIMEOUT_MS = resolveTimeoutPolicy({ stage: "tts-mossland" }).totalMs;

/** 通用 fetch 封装：Bearer 鉴权 + AbortController 超时。 */
async function mossFetch(
  url: string,
  init: RequestInit & { apiKey: string; timeoutMs?: number },
): Promise<Response> {
  return mosslandFetch(url, { timeoutMs: DEFAULT_TIMEOUT_MS, ...init });
}

// ── synthesize ──────────────────────────────────────────────

export interface MosslandSynthesizeOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  speed?: number;   // 旧调用兼容：同步接口当前不发送该字段
  volume?: number;  // 旧调用兼容：同步接口当前不发送该字段
  model?: string;
  format?: MosslandSyncFormat | "pcm";  // pcm 仅为旧配置兼容输入，会在请求前明确拒绝
}

export interface MosslandSynthesizeResult {
  audio: Buffer;
  format: MosslandSyncFormat;
}

/**
 * 单说话人合成：POST /v1/audio/speech。
 * 用 delivery_method=audio 拿到二进制流（不需要再 GET URL，省一轮）。
 */
export async function synthesize(opts: MosslandSynthesizeOptions): Promise<MosslandSynthesizeResult> {
  const format = opts.format ?? "mp3";
  const model = opts.model ?? DEFAULT_MOSSLAND_TTS_MODEL;

  if (!opts.apiKey) throw new Error("Mossland 合成失败：缺少 API Key");
  if (!opts.voiceId) throw new Error("Mossland 合成失败：缺少 voice_id（请先克隆音色）");
  if (!opts.text) throw new Error("Mossland 合成失败：缺少待合成文本");
  if (format === "pcm") {
    throw new Error("Mossland 合成失败：当前客户端的同步播放链路不支持 pcm，请使用 mp3 或 wav");
  }

  // 只传文档里列出的字段；Mossland 严格校验，未知字段直接 400
  const body: Record<string, unknown> = {
    model,
    input: opts.text,
    voice_id: opts.voiceId,
    response_format: format,
    delivery_method: "audio",
  };

  const response = await mossFetch(`${BASE_URL}/v1/audio/speech`, {
    method: "POST",
    apiKey: opts.apiKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const raw = await response.text();
    console.error("[Mossland] 合成失败 HTTP", response.status, "body:", raw);
    throw buildMosslandError("Mossland 合成失败", response.status, raw);
  }

  // delivery_method=audio：响应体直接是音频二进制
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new Error("Mossland 合成失败：服务端返回空音频");
  }
  return { audio, format };
}

// ── streamSynthesize ────────────────────────────────────────

export interface MosslandStreamSynthesizeOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  model?: string;
  language?: string;
  speed?: number;
  expectedDurationSec?: number;
  onAudio?: (chunk: Buffer) => void;
}

/**
 * TTS 1.5 Flash 流式合成。返回的是带格式元数据的 PCM 分片，调用方必须用
 * PCM 播放器消费，不能把分片直接交给现有的 MP3 MediaSource 播放链路。
 */
export async function streamSynthesize(
  opts: MosslandStreamSynthesizeOptions,
): Promise<MosslandPcmStreamInfo> {
  const model = opts.model ?? DEFAULT_MOSSLAND_TTS_MODEL;
  if (!opts.apiKey) throw new Error("Mossland 流式合成失败：缺少 API Key");
  if (!opts.voiceId) throw new Error("Mossland 流式合成失败：缺少 voice_id");
  if (!opts.text?.trim()) throw new Error("Mossland 流式合成失败：缺少待合成文本");
  if (model !== DEFAULT_MOSSLAND_TTS_MODEL) {
    throw new Error(`Mossland 流式合成失败：仅支持 ${DEFAULT_MOSSLAND_TTS_MODEL}`);
  }
  if (opts.speed !== undefined && (!Number.isFinite(opts.speed) || opts.speed < 0.25 || opts.speed > 4)) {
    throw new Error("Mossland 流式合成失败：speed 必须在 0.25 到 4 之间");
  }
  if (opts.expectedDurationSec !== undefined
      && (!Number.isFinite(opts.expectedDurationSec) || opts.expectedDurationSec <= 0)) {
    throw new Error("Mossland 流式合成失败：expected_duration_sec 必须大于 0");
  }

  const body: Record<string, unknown> = {
    model,
    input: opts.text,
    voice_id: opts.voiceId,
  };
  const language = opts.language?.trim();
  if (language) body.language = language;
  if (opts.speed !== undefined) body.speed = opts.speed;
  if (opts.expectedDurationSec !== undefined) body.expected_duration_sec = opts.expectedDurationSec;
  Object.assign(body, {
    stream: true,
    response_format: "pcm",
    stream_format: "sse",
  });

  const response = await mossFetch(`${BASE_URL}/v1/audio/speech`, {
    method: "POST",
    apiKey: opts.apiKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw buildMosslandError("Mossland 流式合成失败", response.status, raw);
  }
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    throw new Error(`Mossland 流式合成失败：服务端返回了意外的 Content-Type（${contentType || "未知"}）`);
  }
  return consumeMosslandSse(response, { onAudio: opts.onAudio });
}

// ── cloneVoice ──────────────────────────────────────────────

export interface MosslandCloneOptions {
  apiKey: string;
  filePath: string;             // 本地音频绝对路径
  name?: string;
  description?: string;
}

export interface MosslandCloneResult {
  voiceId: string;
  name?: string;
  createdAt?: number;           // Unix 秒
}

/**
 * 音色克隆：POST /v1/audio/voices（multipart/form-data）。
 * 字段 audio_sample（必填）+ name（可选）+ description（可选）。
 */
export async function cloneVoice(opts: MosslandCloneOptions): Promise<MosslandCloneResult> {
  if (!opts.apiKey) throw new Error("Mossland 克隆失败：缺少 API Key");
  if (!opts.filePath || !fs.existsSync(opts.filePath)) {
    throw new Error(`Mossland 克隆失败：参考音频不存在 (${opts.filePath ?? ""})`);
  }

  // 文件名只取扩展名，主体用固定 ASCII 名，避免中文文件名导致 header 编码问题
  const ext = path.extname(opts.filePath) || ".wav";
  const safeFileName = "audio_sample" + ext;
  const fileBuffer = fs.readFileSync(opts.filePath);

  // 构造 multipart/form-data（参考 minimax-engine.uploadFile 的写法）
  const boundary = "----CyreneMossland" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  // audio_sample 文件字段
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio_sample"; filename="${safeFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from("\r\n"));

  // 可选文本字段：name / description（用 UTF-8 编码）
  if (opts.name) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${opts.name}\r\n`,
        "utf-8",
      ),
    );
  }
  if (opts.description) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${opts.description}\r\n`,
        "utf-8",
      ),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const response = await mossFetch(`${BASE_URL}/v1/audio/voices`, {
    method: "POST",
    apiKey: opts.apiKey,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!response.ok) {
    const raw = await response.text();
    throw buildMosslandError("Mossland 克隆失败", response.status, raw);
  }

  const data = (await response.json()) as {
    id?: string;
    object?: string;
    name?: string;
    created_at?: number;
  };
  if (!data.id) {
    throw new Error("Mossland 克隆失败：服务端未返回 voice_id");
  }
  return {
    voiceId: data.id,
    name: data.name,
    createdAt: data.created_at,
  };
}

// ── listVoices ──────────────────────────────────────────────

export interface MosslandVoiceInfo {
  id: string;
  name: string;
  createdAt: number;            // Unix 秒
}

export interface MosslandListVoicesResult {
  voices: MosslandVoiceInfo[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface MosslandListVoicesOptions {
  apiKey: string;
  limit?: number;
  offset?: number;
  after?: string;
  status?: string;
}

/**
 * 拉取账号下已克隆的音色列表：GET /v1/audio/voices?limit=50。
 * 返回 { data, has_more, ... }，只取 data 数组。
 * Mossland 文档没有 GET /v1/audio/voices/{id}，所以这里只能 list。
 */
export async function listVoices(opts: MosslandListVoicesOptions): Promise<MosslandListVoicesResult> {
  if (!opts.apiKey) throw new Error("Mossland 拉取音色列表失败：缺少 API Key");

  const requestedLimit = typeof opts.limit === "number" && Number.isFinite(opts.limit)
    ? Math.trunc(opts.limit)
    : 50;
  const limit = Math.max(1, Math.min(150, requestedLimit));
  const query = new URLSearchParams({ limit: String(limit) });
  if (typeof opts.offset === "number" && Number.isFinite(opts.offset) && opts.offset >= 0) {
    query.set("offset", String(Math.trunc(opts.offset)));
  }
  if (opts.after) query.set("after", opts.after);
  if (opts.status) query.set("status", opts.status);
  const url = `${BASE_URL}/v1/audio/voices?${query.toString()}`;

  const response = await mossFetch(url, {
    method: "GET",
    apiKey: opts.apiKey,
  });

  if (!response.ok) {
    const raw = await response.text();
    throw buildMosslandError("Mossland 拉取音色列表失败", response.status, raw);
  }

  const data = (await response.json()) as {
    data?: Array<{ id?: string; name?: string; created_at?: number }>;
    has_more?: boolean;
    next_cursor?: string;
  };
  const voices: MosslandVoiceInfo[] = [];
  for (const v of data.data ?? []) {
    if (!v.id) continue;
    voices.push({
      id: v.id,
      name: v.name?.trim() || "(未命名)",
      createdAt: typeof v.created_at === "number" ? v.created_at : 0,
    });
  }
  return {
    voices,
    hasMore: data.has_more === true,
    nextCursor: data.next_cursor || undefined,
  };
}
