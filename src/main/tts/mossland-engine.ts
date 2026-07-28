// Mossland TTS 引擎（api.mosi.cn / Mossland 云端）。
//
// 第二步接通的功能：
//   - synthesize()      POST /v1/audio/speech       单说话人 moss-tts（delivery_method=audio → binary）
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

const BASE_URL = "https://api.mosi.cn";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 错误码 → 中文友好消息。Mossland 文档列出的常见 code 都覆盖上；
 * 命中未列出的 code 就回落到服务端 message 字段。
 */
const ERROR_CODE_MAP: Record<string, string> = {
  // 4xx
  missing_required_field: "必填字段缺失，请检查后重试",
  invalid_field_value: "字段值不合法，请检查后重试",
  unsupported_response_format: "不支持的音频格式，请使用 mp3 / wav / pcm",
  invalid_url: "URL 非法",
  url_not_allowed: "URL 不被允许（仅 HTTPS 公网）",
  insufficient_credits: "余额不足，请前往控制台充值",
  authentication_error: "API Key 无效，请检查 Authorization 头",
  permission_error: "无权限访问，请确认 API Key 是否正确",
  file_not_found: "文件不存在",
  voice_not_found: "音色不存在，请重新创建后重试",
  task_not_found: "任务不存在",
  rate_limit_exceeded: "请求过于频繁，请稍后再试",
  concurrency_limit_exceeded: "并发超限，请稍后再试",
  safety_guardrail_blocked: "内容被安全策略拦截，请修改后重试",
  // 5xx
  internal: "服务内部错误，请稍后重试",
  upstream: "上游服务异常，请稍后重试",
  service: "服务暂时不可用，请稍后重试",
  timeout: "请求超时，请稍后重试",
};

interface MosslandErrorBody {
  error?: {
    // 同步错误格式（文档标注）：message / type / param / code
    message?: string;
    type?: string;
    param?: string | null;
    code?: string;
    // 异步 / 任务失败格式（实际观测）：error_code / error_msg
    error_code?: number | string;
    error_msg?: string;
    internal_error_msg?: string;
  };
}

/** 把 fetch 错误响应统一解析成 "code + 中文消息"，方便调用方上抛。 */
function buildError(prefix: string, status: number, rawBody: string): Error {
  // HTTP 413：网关层 body 大小限制，服务端没解析 body 就拒了，不会有 JSON 错误体
  if (status === 413) {
    return new Error(`${prefix}：上传的文件太大，超过了服务端限制（HTTP 413）。请压缩或截短音频后重试。`);
  }
  // 尝试解析 JSON 错误体（Mossland 有两种错误格式：同步 code/message，异步 error_code/error_msg）
  let code: string | undefined;
  let upstreamMsg: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as MosslandErrorBody;
    // 异步 / 任务失败格式优先（error_code + error_msg）
    if (parsed.error?.error_msg) {
      code = String(parsed.error.error_code ?? "");
      upstreamMsg = parsed.error.error_msg;
    } else {
      // 同步错误格式（code + message）
      code = parsed.error?.code;
      upstreamMsg = parsed.error?.message;
    }
  } catch {
    // 非 JSON 错误体（如网关层拦截），原样抛
    return new Error(`${prefix}：HTTP ${status} ${rawBody.slice(0, 200)}`);
  }
  const friendly = code && ERROR_CODE_MAP[code];
  const detail = friendly ?? upstreamMsg ?? `未知错误 (code: ${code ?? "?"})`;
  return new Error(`${prefix}：${detail} (HTTP ${status}${code ? `, code: ${code}` : ""})`);
}

/** 通用 fetch 封装：Bearer 鉴权 + AbortController 超时。 */
async function mossFetch(
  url: string,
  init: RequestInit & { apiKey: string; timeoutMs?: number },
): Promise<Response> {
  const { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(rest.headers ?? {}),
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── synthesize ──────────────────────────────────────────────

export interface MosslandSynthesizeOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  speed?: number;
  volume?: number;
  model?: string;                       // 默认 "moss-tts"
  format?: "mp3" | "wav" | "pcm";       // 默认 "mp3"
}

export interface MosslandSynthesizeResult {
  audio: Buffer;
  format: "mp3" | "wav" | "pcm";
}

/**
 * 单说话人合成：POST /v1/audio/speech。
 * 用 delivery_method=audio 拿到二进制流（不需要再 GET URL，省一轮）。
 */
export async function synthesize(opts: MosslandSynthesizeOptions): Promise<MosslandSynthesizeResult> {
  const format = opts.format ?? "mp3";
  const model = opts.model ?? "moss-tts";

  if (!opts.apiKey) throw new Error("Mossland 合成失败：缺少 API Key");
  if (!opts.voiceId) throw new Error("Mossland 合成失败：缺少 voice_id（请先克隆音色）");
  if (!opts.text) throw new Error("Mossland 合成失败：缺少待合成文本");

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
    throw buildError("Mossland 合成失败", response.status, raw);
  }

  // delivery_method=audio：响应体直接是音频二进制
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new Error("Mossland 合成失败：服务端返回空音频");
  }
  return { audio, format };
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
    throw buildError("Mossland 克隆失败", response.status, raw);
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
}

/**
 * 拉取账号下已克隆的音色列表：GET /v1/audio/voices?limit=50。
 * 返回 { data, has_more, ... }，只取 data 数组。
 * Mossland 文档没有 GET /v1/audio/voices/{id}，所以这里只能 list。
 */
export async function listVoices(opts: { apiKey: string; limit?: number }): Promise<MosslandListVoicesResult> {
  if (!opts.apiKey) throw new Error("Mossland 拉取音色列表失败：缺少 API Key");

  const limit = opts.limit ?? 50;
  const url = `${BASE_URL}/v1/audio/voices?limit=${limit}`;

  const response = await mossFetch(url, {
    method: "GET",
    apiKey: opts.apiKey,
  });

  if (!response.ok) {
    const raw = await response.text();
    throw buildError("Mossland 拉取音色列表失败", response.status, raw);
  }

  const data = (await response.json()) as {
    data?: Array<{ id?: string; name?: string; created_at?: number }>;
  };
  const voices: MosslandVoiceInfo[] = [];
  for (const v of data.data ?? []) {
    if (!v.id) continue;
    voices.push({
      id: v.id,
      name: v.name ?? "(未命名)",
      createdAt: typeof v.created_at === "number" ? v.created_at : 0,
    });
  }
  return { voices };
}