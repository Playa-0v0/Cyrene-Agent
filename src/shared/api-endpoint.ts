export type ApiTransport = "openai" | "anthropic" | "responses";

export interface ResolvedApiEndpoint {
  url: string;
  /** null 表示用户已经填写完整 endpoint，程序不会再追加路径。 */
  appendedSuffix: string | null;
}

/**
 * 把设置页填写的 Base URL 解析成实际请求地址。
 * Main 进程和 Settings UI 必须共用这一实现，避免提示与真实请求产生漂移。
 */
export function resolveApiEndpoint(baseUrl: string, transport: ApiTransport): ResolvedApiEndpoint {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  if (transport === "anthropic") {
    if (trimmed.endsWith("/messages")) return { url: trimmed, appendedSuffix: null };
    if (trimmed.endsWith("/v1")) {
      return { url: `${trimmed}/messages`, appendedSuffix: "/messages" };
    }
    return { url: `${trimmed}/v1/messages`, appendedSuffix: "/v1/messages" };
  }

  if (transport === "responses") {
    // OpenAI Responses API：baseUrl 已含版本前缀（如 /v1、/api/v3），只追加 /responses。
    if (trimmed.endsWith("/responses")) return { url: trimmed, appendedSuffix: null };
    return { url: `${trimmed}/responses`, appendedSuffix: "/responses" };
  }

  if (trimmed.endsWith("/chat/completions")) return { url: trimmed, appendedSuffix: null };
  return { url: `${trimmed}/chat/completions`, appendedSuffix: "/chat/completions" };
}
