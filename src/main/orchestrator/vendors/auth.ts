// 厂商鉴权 header 抽象 —— transport 与 authStyle 解耦
//
// 设计动机：之前 OpenAI/Anthropic adapter 各自硬编码鉴权 header 名
// （OpenAI 写死 Authorization: Bearer，Anthropic 写死 x-api-key），
// 导致 Anthropic transport 没法配 bearer，反之亦然。
// 现在 authHeaderFor(cap, apiKey) 根据 capability.authStyle 生成 header，
// Anthropic transport + bearer 也合法（如 MiMo /anthropic 端点）。
//
// 运行时若 cap.authStyle 不是合法值，直接抛出明确的配置错误。
// 不静默省略鉴权 header——那只会让请求落到服务器得到一个模糊的 401，
// 不便于定位是 capability 配错了还是 apiKey 错了。
import type { ProviderCapability } from "./types";

export function authHeaderFor(
  cap: ProviderCapability,
  apiKey: string,
): Record<string, string> {
  if (!apiKey) return {};
  switch (cap.authStyle) {
    case "x-api-key":
      return { "x-api-key": apiKey };
    case "bearer":
      return { Authorization: `Bearer ${apiKey}` };
    default:
      throw new Error(
        `[vendors/auth] Provider "${cap.displayName}" has invalid authStyle: ` +
          `${JSON.stringify(cap.authStyle)} (expected "bearer" | "x-api-key")`,
      );
  }
}