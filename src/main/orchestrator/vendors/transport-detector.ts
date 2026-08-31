// Transport selection —— 只接受用户显式选择，不再根据 Base URL 猜协议。
// 老配置若没有具体值，仅回退到厂商能力表默认值；设置存储层会在下次保存时
// 将其固化为 "openai" 或 "anthropic"。

import type { Transport } from "./types";
import { getCapabilityOrOpenAI } from "./capabilities";

/** 运行时只尊重具体协议；"auto" 仅作为旧配置兼容输入。 */
export function resolveTransport(cfg: {
  baseUrl: string;
  explicitTransport?: Transport | "auto" | undefined;
  provider: string;
}): Transport {
  if (cfg.explicitTransport === "openai" || cfg.explicitTransport === "anthropic" || cfg.explicitTransport === "responses") {
    return cfg.explicitTransport;
  }
  return getCapabilityOrOpenAI(cfg.provider).transport;
}
