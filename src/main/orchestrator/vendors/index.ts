// 廠商適配器工廠：按 provider 顯示名或 VendorConfig 返回對應 transport 的 adapter 實例。
// 調度層只需 getAdapter(provider) 或 getAdapterForConfig(cfg)，不關心 transport 細節。
import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import { getCapability, getCapabilityOrOpenAI, PROVIDER_CAPABILITIES } from "./capabilities";
import { resolveTransport } from "./transport-detector";
import type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, StreamChunk, StreamEvent, TestConnectionResult, ToolCall, ToolExecutionResult,
  ToolSpec, Transport, VendorConfig,
} from "./types";

export type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, StreamChunk, StreamEvent, TestConnectionResult, ToolCall, ToolExecutionResult,
  ToolSpec, Transport, VendorConfig,
};
export { getCapability, getCapabilityOrOpenAI, PROVIDER_CAPABILITIES };
export { detectTransport, resolveTransport } from "./transport-detector";

const cache = new Map<string, ChatVendorAdapter>();

/** 按 provider 顯示名取適配器實例（同一 provider 複用同一實例）—— 舊路徑，按 capabilities 表 transport 取。 */
export function getAdapter(provider: string): ChatVendorAdapter {
  const existing = cache.get(provider);
  if (existing) return existing;
  const cap = getCapabilityOrOpenAI(provider);
  const adapter: ChatVendorAdapter =
    cap.transport === "anthropic"
      ? new AnthropicAdapter(cap.id, cap)
      : new OpenAICompatAdapter(cap.id, cap);
  cache.set(provider, adapter);
  return adapter;
}

/**
 * 按運行時配置取適配器實例。三層 transport 解析：
 *   1. cfg.explicitTransport（用戶顯式）
 *   2. baseUrl 啟發式（detectTransport）
 *   3. capabilities 表默認
 * cache key 用 `${provider}::${transport}`，避免顯式切 transport 後命中舊實例。
 */
export function getAdapterForConfig(cfg: VendorConfig): ChatVendorAdapter {
  const transport = resolveTransport({
    baseUrl: cfg.baseUrl,
    explicitTransport: cfg.explicitTransport,
    provider: cfg.provider,
  });
  const cacheKey = `${cfg.provider}::${transport}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const cap = getCapabilityOrOpenAI(cfg.provider);
  const adapter: ChatVendorAdapter =
    transport === "anthropic"
      ? new AnthropicAdapter(cap.id, cap)
      : new OpenAICompatAdapter(cap.id, cap);
  cache.set(cacheKey, adapter);
  return adapter;
}

/**
 * 廠商無關的 URL 構建器 —— transport 由調用方傳入（已走 resolveTransport）。
 * - OpenAI transport → {baseUrl}/chat/completions
 * - Anthropic transport → {baseUrl}/v1/messages（baseUrl 已含 /v1 時只加 /messages）
 */
export function buildVendorUrl(baseUrl: string, transport: Transport): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (transport === "anthropic") {
    if (trimmed.endsWith("/messages")) return trimmed;
    if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
    return `${trimmed}/v1/messages`;
  }
  // OpenAI transport
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * 舊簽名（保留兼容）：根據 provider 名查 transport 再調 buildVendorUrl。
 * 已有調用點（memory-judge / memory-compressor 之前的 buildVendorUrl(provider, baseUrl)）仍可用，
 * 但**新代碼**建議直接用 buildVendorUrl(baseUrl, transport) + getAdapterForConfig(cfg)。
 */
export function buildVendorUrlByProvider(provider: string, baseUrl: string): string {
  const cap = getCapabilityOrOpenAI(provider);
  return buildVendorUrl(baseUrl, cap.transport);
}

/**
 * 創建一個 AsyncIterable<StreamEvent>，按 transport 協議切分 HTTP body 字節流。
 *
 * - OpenAI SSE 格式：每條 event 由單個 `data: {...}` 行組成（行間用 \n\n 分隔）。
 *   → 產出 StreamEvent{ eventType: "data", data: "{...}" }
 * - Anthropic event-stream 格式：每條 event 由 `event: <type>\ndata: {...}` 兩行組成。
 *   → 產出 StreamEvent{ eventType: "<type>", data: "{...}" }
 *
 * 切分規則都是按 \n\n（空行）分隔 event 塊，所以兩種協議可以共用同一套狀態機。
 * Adapter 的 parseStreamEvent 是純函數、無狀態；所有"半行拼接"邏輯都在這裡維護。
 */
export function createSseReader(
  _adapter: ChatVendorAdapter,
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  let buffer = "";

  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          // 循環：一直讀到能切出一個完整 event 塊為止
          // （半行數據跨多個 chunk 時會繼續 read + append buffer）
          while (true) {
            const splitAt = buffer.indexOf("\n\n");
            if (splitAt !== -1) {
              const raw = buffer.slice(0, splitAt);
              buffer = buffer.slice(splitAt + 2);
              const event = parseSseBlock(raw);
              if (event) return { value: event, done: false };
              // 空註釋塊（OpenAI 心跳）跳過，繼續找下一個
              continue;
            }
            // buffer 裡沒有完整 event 塊，需要更多字節
            const { value, done } = await reader.read();
            if (done) {
              // 流結束：把 buffer 殘餘（如果有）當最後一個 event 處理；否則返回 done
              if (buffer.trim().length > 0) {
                const event = parseSseBlock(buffer);
                buffer = "";
                if (event) return { value: event, done: false };
              }
              return { value: undefined, done: true };
            }
            buffer += decoder.decode(value, { stream: true });
          }
        },
        async return(): Promise<IteratorResult<StreamEvent>> {
          try { await reader.cancel(); } catch { /* ignore */ }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * 把一個 SSE event 塊（一組行，可能是 `data: ...` 單行，也可能是 `event: ...\ndata: ...` 兩行）
 * 解析成 StreamEvent。返回 null 表示這一塊是註釋（OpenAI 心跳 `: ...`）或空塊。
 */
function parseSseBlock(block: string): StreamEvent | null {
  let eventType = "data"; // OpenAI 默認
  let dataLine = "";
  let hasData = false;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue; // 空行 / 註釋行
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLine = line.slice(5).trimStart();
      hasData = true;
    }
    // 其他字段（id: / retry:）當前用不到，忽略
  }
  if (!hasData) return null;
  return { eventType, data: dataLine };
}