// Anthropic transport —— MiniMax（主推）/ Claude
// 请求体协议：POST {baseUrl}/v1/messages（baseUrl 已含 /v1 时只加 /messages）
// system 顶层 + messages[].content 为 content block 数组 + tools[].input_schema
//
// 鉴权由 authHeaderFor 根据 capability.authStyle 决定——Anthropic transport
// 也可以配 bearer（如 MiMo /anthropic 端点）。
import {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter,
  HttpRequest, ProviderCapability, StreamChunk, StreamEvent,
  TestConnectionResult, ToolCall, ToolExecutionResult, VendorConfig,
} from "./types";
import { authHeaderFor } from "./auth";
import { resolveReasoningCapability } from "../../../shared/reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";

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
 * 把统一消息翻译成 Anthropic wire messages。
 * system 抽出来单独返回（Anthropic system 是顶层字段）。
 * 关键：assistant 若带 rawAssistant（上一轮原始 content block 数组）则原样回传，
 * 保证 thinking / tool_use block 完整回灌（MiniMax 多轮强制要求）。
 * tool 结果：Anthropic 用 user 角色的 tool_result block，同轮多个合并到同一条 user message。
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
    // temperature 只在调用方显式传时才塞进 body，让厂商用默认值避免型号约束冲突
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // system + 主动缓存（MiniMax/Claude：cache_control: ephemeral 打在 system block 上）
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
      body.tool_choice = req.toolChoice
        ? { type: "tool", name: req.toolChoice.name }
        : { type: "auto" };
    }
    if (req.extraBody) Object.assign(body, req.extraBody);
    // 推理控制：按 (providerId, model) 解析 capability，调用 applyReasoningPreference 转换 body。
    const reasoningCap = resolveReasoningCapability(this.capability.id, cfg.model);
    const finalBody = applyReasoningPreference(
      body,
      cfg.reasoning ?? { mode: "auto" },
      reasoningCap,
      {
        hasTools: Boolean(req.tools?.length),
        providerId: this.capability.id,
        model: cfg.model,
      },
    );
    return {
      url: buildUrl(cfg.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaderFor(this.capability, cfg.apiKey),
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(finalBody),
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
    // 调度层用 toolCalls.length>0 判断是否继续；finishReason 也映射成 OpenAI 习惯便于日志统一
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
      // 关键：原样保留 content block 数组，下一轮 buildRequest 直接回传给厂商
      rawAssistant: blocks,
    };

    // 提取 token 用量（Anthropic 协议: input_tokens/output_tokens）
    const usage = data.usage
      ? { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0 }
      : undefined;

    return { assistantMessage, text, thinking, toolCalls, finishReason, raw, usage };
  }

  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    // 复用 buildRequest：adapter 内部已按 req.stream 写 body，强制 stream=true
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
        // 暂不实现：d.type === "input_json_delta" → 累积到 deltaToolCalls
        // 当前三个调用点都不带 tools；未来若需要流式 tool_use 增量，单独实现 + 加测试即可。
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
      // 其他事件（message_start / content_block_start / content_block_stop / ping 等）静默忽略
      default:
        return null;
    }
  }

  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      // 统一层一律 push role:"tool"；Anthropic 的合并（同轮 tool_result 进同一条 user message）
      // 由 buildRequest 的 toWireMessages 负责，这里保持 transport 无关。
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
    const timer = setTimeout(() => controller.abort(), getTimeoutSettings().testTimeout);
    try {
      const req: ChatRequest = {
        model: cfg.model,
        messages: [{ role: "user", content: "ping，请只回复两个字符：ok" }],
        // 不传 temperature：某些模型只允许特定值，传 0 会报错
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
      return { ok: true, latency, sample: parsed.text.slice(0, 80) || "(空回复)" };
    } catch (e) {
      return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
