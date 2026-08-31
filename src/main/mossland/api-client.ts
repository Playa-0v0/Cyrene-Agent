import { resolveTimeoutPolicy } from "../runtime-policy";

export const MOSSLAND_BASE_URL = "https://api.mosi.cn";

const ERROR_CODE_MAP: Record<string, string> = {
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
  internal: "服务内部错误，请稍后重试",
  upstream: "上游服务异常，请稍后重试",
  service: "服务暂时不可用，请稍后重试",
  timeout: "请求超时，请稍后重试",
};

interface MosslandErrorBody {
  error?: {
    message?: string;
    type?: string;
    param?: string | null;
    code?: string;
    error_code?: number | string;
    error_msg?: string;
    internal_error_msg?: string;
  };
}

export function buildMosslandError(prefix: string, status: number, rawBody: string): Error {
  if (status === 413) {
    return new Error(`${prefix}：上传的文件太大，超过了服务端限制（HTTP 413）。请压缩或截短音频后重试。`);
  }

  let code: string | undefined;
  let upstreamMsg: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as MosslandErrorBody;
    if (parsed.error?.error_msg) {
      code = String(parsed.error.error_code ?? "");
      upstreamMsg = parsed.error.error_msg;
    } else {
      code = parsed.error?.code;
      upstreamMsg = parsed.error?.message;
    }
  } catch {
    return new Error(`${prefix}：HTTP ${status} ${rawBody.slice(0, 200)}`);
  }

  const friendly = code && ERROR_CODE_MAP[code];
  const detail = friendly ?? upstreamMsg ?? `未知错误 (code: ${code ?? "?"})`;
  return new Error(`${prefix}：${detail} (HTTP ${status}${code ? `, code: ${code}` : ""})`);
}

export async function mosslandFetch(
  url: string,
  init: RequestInit & { apiKey: string; timeoutMs?: number },
): Promise<Response> {
  const {
    apiKey,
    timeoutMs = resolveTimeoutPolicy({ stage: "external-http" }).totalMs,
    ...rest
  } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(rest.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
