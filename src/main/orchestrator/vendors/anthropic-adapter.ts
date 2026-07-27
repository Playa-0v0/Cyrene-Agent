// Anthropic transport —— MiniMax（主推）/ Claude
// 請求體協議：POST {baseUrl}/v1/messages（baseUrl 已含 /v1 時只加 /messages）
// system 頂層 + messages[].content 為 content block 數組 + tools[].input_schema
import {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter,
  HttpRequest, ProviderCapability, StreamChunk, StreamEvent,
  TestConnectionResult, ToolCall, ToolExecutionResult, VendorConfig,
} from "./types";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

function buildUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

/**
 * 把統一消息翻譯成 Anthropic wire messages。
 * system 抽出來單獨返回（Anthropic system 是頂層字段）。
 * 關鍵：assistant 若帶 rawAssistant（上一輪原始 content block 數組）則原樣回傳，
 * 保證 thinking / tool_use block 完整回灌（MiniMax 多輪強制要求）。
 * tool 結果：Anthropic 用 user 角色的 tool_result block，同輪多個合併到同一條 user message。
 */
function toWireMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<Record<string, unknown>>;
} {
  const systemText = messages
    .filter(m => m.role === "system")
    .map(m => m.content ?? "")
    .join("\n\n")
    .trim();
  const system = systemText || undefined;

  const wire: Array<Record<string, unknown>> = [];
  for (const m of messages.filter(x => x.role !== "system")) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      if (m.rawAssistant !== undefined) {
        wire.push({ role: "assistant", content: m.rawAssistant });
      } else {
        const blocks: ContentBlock[] = [];
        if (m.thinking) blocks.push({ type: "thinking", thinking: m.thinking });
        if (m.content) blocks.push({ type: "text", text: m.content });
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.arguments || "{}");
            } catch {
              input = {};
            }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
          }
        }
        wire.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      }
    } else if (m.role === "tool") {
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content ?? "",
      };
      const last = wire[wire.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as ContentBlock[]).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
    }
  }
  return { system, messages: wire };
}

export class AnthropicAdapter implements ChatVendorAdapter {
  readonly transport = "anthropic" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const { system, messages } = toWireMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: req.stream ?? false,
    };
    // temperature 只在調用方顯式傳時才塞進 body，讓廠商用默認值避免型號約束衝突
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // system + 主動緩存（MiniMax/Claude：cache_control: ephemeral 打在 system block 上）
    if (system) {
      if (this.capability.cacheStrategy === "cache_control") {
        body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      } else {
        body.system = system;
      }
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      body.tool_choice = { type: "auto" };
    }
    if (req.extraBody) Object.assign(body, req.extraBody);
    return {
      url: buildUrl(cfg.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(raw: unknown): ChatResponse {
    const data = raw as {
      content?: ContentBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = data.content ?? [];
    let text = "";
    let thinking: string | undefined;
    const toolCalls: ToolCall[] = [];

    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      } else if (
        (b.type === "thinking" || b.type === "reasoning" || b.type === "reasoning_details") &&
        typeof (b.thinking ?? b.reasoning) === "string"
      ) {
        thinking = (thinking ?? "") + String(b.thinking ?? b.reasoning);
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
    }

    const stopReason = data.stop_reason ?? "end_turn";
    // 調度層用 toolCalls.length>0 判斷是否繼續；finishReason 也映射成 OpenAI 習慣便於日誌統一
    const finishReason =
      stopReason === "tool_use" ? "tool_calls"
      : stopReason === "end_turn" ? "stop"
      : stopReason === "max_tokens" ? "length"
      : stopReason;

    const assistantMessage: ChatMessage = {
      role: "assistant",
      ...(text ? { content: text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      // 關鍵：原樣保留 content block 數組，下一輪 buildRequest 直接回傳給廠商
      rawAssistant: blocks,
    };

    // 提取 token 用量（Anthropic 協議: input_tokens/output_tokens）
    const usage = data.usage
      ? { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0 }
      : undefined;

    return { assistantMessage, text, thinking, toolCalls, finishReason, raw, usage };
  }

  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    // 複用 buildRequest：adapter 內部已按 req.stream 寫 body，強制 stream=true
    return this.buildRequest({ ...req, stream: true }, cfg);
  }

  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    // Anthropic 流式：eventType 是事件名，data 是 JSON
    let parsed: { delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return null;
    }

    switch (event.eventType) {
      case "content_block_delta": {
        const d = parsed.delta;
        if (!d) return null;
        const chunk: StreamChunk = {};
        if (d.type === "text_delta" && typeof d.text === "string") chunk.deltaText = d.text;
        if (d.type === "thinking_delta" && typeof d.thinking === "string") chunk.deltaThinking = d.thinking;
        // 暫不實現：d.type === "input_json_delta" → 累積到 deltaToolCalls
        // 當前三個調用點都不帶 tools；未來若需要流式 tool_use 增量，單獨實現 + 加測試即可。
        return Object.keys(chunk).length > 0 ? chunk : null;
      }
      case "message_delta": {
        if (parsed.usage) {
          return {
            usage: {
              input: parsed.usage.input_tokens ?? 0,
              output: parsed.usage.output_tokens ?? 0,
            },
          };
        }
        return null;
      }
      case "message_stop":
        return { done: true };
      // 其他事件（message_start / content_block_start / content_block_stop / ping 等）靜默忽略
      default:
        return null;
    }
  }

  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      // 統一層一律 push role:"tool"；Anthropic 的合併（同輪 tool_result 進同一條 user message）
      // 由 buildRequest 的 toWireMessages 負責，這裡保持 transport 無關。
      next.push({
        role: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        content: r.output,
      });
    }
    return next;
  }

  async testConnection(cfg: VendorConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const req: ChatRequest = {
        model: cfg.model,
        messages: [{ role: "user", content: "ping，請只回復兩個字符：ok" }],
        // 不傳 temperature：某些模型只允許特定值，傳 0 會報錯
        stream: false,
      };
      const http = this.buildRequest(req, cfg);
      const res = await fetch(http.url, {
        method: "POST",
        signal: controller.signal,
        headers: http.headers,
        body: http.body,
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, latency, error: `HTTP ${res.status} ${t.slice(0, 200)}` };
      }
      const data = await res.json();
      const parsed = this.parseResponse(data);
      return { ok: true, latency, sample: parsed.text.slice(0, 80) || "(空回覆)" };
    } catch (e) {
      return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
