// OpenAI 兼容 transport —— 覆蓋 火山 AgentPlan / DeepSeek / GLM / Kimi / Qwen / ChatGPT
// 請求體協議：POST {baseUrl}/chat/completions，messages + tools[].type=function
import {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter,
  HttpRequest, ProviderCapability, StreamChunk, StreamEvent,
  TestConnectionResult, ToolCall, ToolExecutionResult, VendorConfig,
} from "./types";

function buildUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

/** 把統一消息翻譯成 OpenAI wire messages。 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === "system") return { role: "system", content: m.content ?? "" };
    if (m.role === "user") return { role: "user", content: m.content ?? "" };
    if (m.role === "tool") {
      const wire: Record<string, unknown> = {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content ?? "",
      };
      if (m.name) wire.name = m.name;
      return wire;
    }
    // assistant：回傳 content + tool_calls（OpenAI 多輪要求 assistant 消息帶 tool_calls）
    if (m.rawAssistant) {
      return m.rawAssistant;
    }
    const wire: Record<string, unknown> = { role: "assistant", content: m.content || null };
    if (m.thinking) {
      wire.reasoning_content = m.thinking;
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return wire;
  });
}

function toWireTools(tools?: ChatRequest["tools"]): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OpenAICompatAdapter implements ChatVendorAdapter {
  readonly transport = "openai" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.messages),
      stream: req.stream ?? false,
    };
    // temperature 只在調用方顯式傳時才塞進 body。
    // 不傳時讓廠商用默認值——不同型號約束不同（如 Kimi k2.6 只允許 1），
    // 硬編碼兜底值會在某些模型上報錯。
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // maxTokens：調用方顯式傳時才塞（流式場景下通常不傳）
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    const tools = toWireTools(req.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (req.extraBody) Object.assign(body, req.extraBody);
    return {
      url: buildUrl(cfg.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    };
  }

  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    // 複用 buildRequest：adapter 內部已按 req.stream 寫 body，強制 stream=true
    return this.buildRequest({ ...req, stream: true }, cfg);
  }

  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    // OpenAI 流式：eventType 始終是 "data"（createSseReader 已統一）
    const jsonStr = event.data.trim();
    if (!jsonStr) return null;
    if (jsonStr === "[DONE]") return { done: true };
    let parsed: { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) {
      // 流末尾的 usage 塊（choices 為空但帶 usage）
      if (parsed?.usage) {
        return {
          usage: {
            input: parsed.usage.prompt_tokens ?? 0,
            output: parsed.usage.completion_tokens ?? 0,
          },
        };
      }
      return null;
    }
    const chunk: StreamChunk = {};
    if (typeof delta.content === "string") chunk.deltaText = delta.content;
    if (typeof delta.reasoning_content === "string") chunk.deltaThinking = delta.reasoning_content;
    // 暫不實現：if (Array.isArray(delta.tool_calls)) chunk.deltaToolCalls = ...
    // 當前三個調用點（MemoryJudge / memory-compressor / 心情觀察器）都不帶 tools，
    // 未來若需要流式 tool_call 增量，單獨實現 + 加測試即可。
    return chunk;
  }

  parseResponse(raw: unknown): ChatResponse {
    const data = raw as {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
          reasoning_content?: string;
          thinking?: string;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const text = msg?.content ?? "";
    const thinking = msg?.reasoning_content || msg?.thinking || undefined;

    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(thinking ? { thinking } : {}),
      rawAssistant: msg,
    };

    // 提取 token 用量（OpenAI 協議: prompt_tokens/completion_tokens）
    const usage = data.usage
      ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 }
      : undefined;

    return {
      assistantMessage,
      text,
      thinking,
      toolCalls,
      finishReason: choice?.finish_reason ?? "stop",
      raw,
      usage,
    };
  }

  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      next.push({
        role: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        content: r.output,
      });
    }
    return next;
  }

  // Kimi：多輪 Agent 強烈建議傳 prompt_cache_key（命中後 usage.cached_tokens 體現）。
  // v1 用"廠商+模型"穩定 key 緩存 system/工具定義；v2 可換成會話級 key。
  applyCacheHints(req: ChatRequest, _cfg: VendorConfig): ChatRequest {
    if (this.capability.cacheStrategy !== "prompt_cache_key") return req;
    const extraBody = { ...(req.extraBody ?? {}), prompt_cache_key: `cyrene:${this.id}` };
    return { ...req, extraBody };
  }

  async testConnection(cfg: VendorConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const req: ChatRequest = {
        model: cfg.model,
        messages: [{ role: "user", content: "ping，請只回復兩個字符：ok" }],
        // 不傳 temperature：某些模型（如 Kimi k2.6）只允許特定值，傳 0 會報錯
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
