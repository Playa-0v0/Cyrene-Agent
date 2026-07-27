// Transport detection —— 根據 baseUrl 啟發式判斷走 OpenAI 還是 Anthropic 協議。
//
// 設計動機：之前 transport 由 provider 名 → capabilities 表硬編碼，
// 用戶在 settings 改 baseUrl 不會影響 dispatch 行為（典型 bug：MiniMax 填 /v1 時仍走 anthropic 端點）。
// 現在三段優先級：
//   1. 用戶顯式 explicitTransport（settings UI 高級選項）
//   2. baseUrl 啟發式（detectTransport）
//   3. capabilities 表默認（舊 fallback，兼容現有 8 家預設）
//
// 啟發式規則：
//   - 路徑含 /anthropic 或 /v1/messages → anthropic
//   - 路徑含 /chat/completions 或 /completions → openai
//   - 僅以 /v1 結尾 → openai（絕大多數 OpenAI 兼容入口用這個後綴）
//   - 其他 → null，讓調用方 fallback

import type { Transport } from "./types";
import { getCapabilityOrOpenAI } from "./capabilities";

/**
 * 根據 baseUrl 路徑形態判斷 transport；無法判斷時返回 null。
 * 純函數，便於單測。
 */
export function detectTransport(baseUrl: string): Transport | null {
  const t = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!t) return null;
  // Anthropic 端點路徑關鍵字
  if (/\/anthropic($|\/)|\/v1\/messages($|\?)/.test(t)) return "anthropic";
  // OpenAI 端點路徑關鍵字
  if (/\/chat\/completions($|\?)|\/completions($|\?)|\/v1\/chat/.test(t)) return "openai";
  // 僅以 /v1 結尾 → 啟發式判為 openai
  if (t.endsWith("/v1")) return "openai";
  return null;
}

/**
 * 三段優先級解析 transport。調用方（getAdapterForConfig）使用。
 *  - explicitTransport = "openai" | "anthropic" → 用戶強制
 *  - explicitTransport = "auto" | undefined → 走 detectTransport → fallback capabilities
 */
export function resolveTransport(cfg: {
  baseUrl: string;
  explicitTransport?: Transport | "auto" | undefined;
  provider: string;
}): Transport {
  if (cfg.explicitTransport === "openai" || cfg.explicitTransport === "anthropic") {
    return cfg.explicitTransport;
  }
  // auto 或 undefined 都走檢測 + fallback
  return detectTransport(cfg.baseUrl) ?? getCapabilityOrOpenAI(cfg.provider).transport;
}