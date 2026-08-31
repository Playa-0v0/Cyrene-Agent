// 厂商工具调用适配层 —— 统一类型
// 调度层（CyreneHarness）只依赖这里的统一结构，绝不出现 if (provider === "xxx")。
// 协议事实来源：docs/vendors/tool-calling-matrix.md

import type { ReasoningPreference } from "../../../shared/reasoning";
import type { PromptLayerMetadata } from "../prompt-layers";

export type Transport = "openai" | "anthropic" | "responses";
export type AuthStyle = "bearer" | "x-api-key";
export type ThinkingField = "reasoning_content" | "thinking" | "reasoning_details" | null;
export type CacheStrategy = "prompt_cache_key" | "cache_control" | "auto" | "none";
export type TestStrategy = "text" | "text+tool";

/** 调度层传入适配器的厂商运行时配置（结构兼容 main/index.ts 的 ModelSettings）。 */
export interface VendorConfig {
  provider: string; // 厂商显示名，如 "MiniMax（稀宇科技）"，与 capability 表的 displayName 对齐
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 用户在 settings UI 显式选择的协议。"auto" 仅作为旧配置兼容输入，运行时不按 URL 推断。
   */
  explicitTransport?: Transport | "auto";
  /**
   * 用户保存的推理偏好。adapter buildRequest 必须透传此字段；
   * 不传时 applyReasoningPreference 缺省按 auto 处理。
   * commit 2 落地后由 ModelSettings 顶层镜像字段填充；commit 1 期间为可选。
   */
  reasoning?: ReasoningPreference;
}

export type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessageContent = string | OpenAIContentBlock[];

/** 统一工具调用描述（项目内部），与 OpenAI/Anthropic wire 格式解耦。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串，沿用 OpenAI 习惯
}

/**
 * 统一消息结构。两个 transport 各自只读自己需要的字段，调度层透传。
 * - OpenAI transport 读 content / toolCalls / toolCallId / name
 * - Anthropic transport 额外读 thinking / rawAssistant（多轮必须原样回传 content block 数组）
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: ChatMessageContent;
  /** assistant 上的工具调用（统一结构，OpenAI wire 再转成 tool_calls[].function）。 */
  toolCalls?: ToolCall[];
  /** role:"tool" 的回填锚点（OpenAI: tool_call_id；Anthropic: tool_use_id）。 */
  toolCallId?: string;
  name?: string;
  /** 思考/推理纯文本（reasoning_content / thinking block 抽出来）。 */
  thinking?: string;
  /** Anthropic 多轮必须原样回传 assistant.content block 数组；OpenAI transport 不读。 */
  rawAssistant?: unknown;
  /** 仅供本地 transcript / UI 使用；Adapter 序列化时不得发送。 */
  visibility?: "user" | "internal";
  /** 仅供本地持久化和去重使用；Adapter 序列化时不得发送。 */
  internal?: {
    kind: "run_start" | "state_delta" | "recovery";
    revision: number;
    digest: string;
    id: string;
    runId: string;
    createdAt: number;
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

export type StructuredOutputRequest =
  | {
      mode: "json_schema";
      name: string;
      schema: object;
      strict: boolean;
    }
  | {
      mode: "json_object";
      /** LangChain responseFormat schema; legacy wire adapters ignore it. */
      name?: string;
      schema?: object;
    }
  | {
      mode: "prompt_json";
      sendJsonObjectHint: boolean;
      /** LangChain responseFormat schema; legacy wire adapters ignore it. */
      name?: string;
      schema?: object;
    };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Runtime semantic intent; the active Adapter maps it to named/required/any/auto/omitted wire syntax. */
  toolChoiceIntent?: { mode: "must_call"; toolName: string };
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  stream?: boolean;
  /** CITA only. Native FC keeps using real tools instead. */
  structuredOutput?: StructuredOutputRequest;
  /**
   * 非流式调用时的 max_tokens 上限（OpenAI wire: `max_tokens`；Anthropic wire 覆盖默认 4096）。
   * 流式时由 adapter 决定是否使用（通常不用--流式靠 finish_reason 判断）。
   */
  maxTokens?: number;
  /** 透传到请求体顶层的厂商扩展字段（如 Kimi 的 prompt_cache_key）。 */
  extraBody?: Record<string, unknown>;
  /** 仅供本地缓存键与诊断使用，Adapter 不得将该字段直接发给厂商。 */
  promptLayers?: PromptLayerMetadata;
}

/**
 * Transport-无关的统一流式事件。
 * Reader 层（createSseReader）把 HTTP body 字节流切分成 StreamEvent 列表；
 * Adapter 层 parseStreamEvent(event) 是纯函数，无状态。
 *
 * - OpenAI 流式：Reader 切出的 eventType 固定为 "data"，data 是 data: {...} 行的 JSON 字符串。
 * - Anthropic 流式：eventType 是事件名（message_start / content_block_delta / message_delta /
 *   message_stop 等），data 是 data: {...} 行的 JSON 字符串。
 */
export interface StreamEvent {
  eventType: string;
  data: string;
}

/**
 * 流式增量块。接口设计比当前需求宽（保留 deltaToolCalls），
 * 但本次两个 adapter 的 parseStreamEvent 实现只解析 deltaText + deltaThinking；
 * 遇到 tool delta 时静默忽略（不报错、不累积）。
 *
 * 未来若 MemoryJudge / 心情观察器想走工具调用，只改 adapter 实现，
 * 不改接口、不改调用方。
 */
export interface StreamChunk {
  deltaText?: string;
  deltaThinking?: string;
  /** Provider-side terminal reason. Usage may still arrive in a later SSE event. */
  finishReason?: string;
  /** A protocol-level error delivered inside an otherwise successful SSE response. */
  error?: string;
  deltaToolCalls?: ToolCall[];
  done?: boolean;
  usage?: { input: number; output: number; cachedInput?: number; cacheCreation?: number };
}

/** 适配器解析后的统一响应，调度层只看这个。 */
export interface ChatResponse {
  /** 要追加进对话的 assistant 消息（保留 thinking / rawAssistant 供下轮回传）。 */
  assistantMessage: ChatMessage;
  text: string;
  thinking?: string;
  /** Provider-declared refusal; it may coexist with a normal-looking finish reason. */
  refusal?: string;
  toolCalls: ToolCall[];
  finishReason: string;
  raw: unknown;
  /** LangChain responseFormat result; absent on the legacy adapter path. */
  structuredValue?: unknown;
  /** API 返回的 token 用量（OpenAI: prompt_tokens/completion_tokens；Anthropic: input_tokens/output_tokens）。
   *  未上报时为 undefined，由调用方兜底。 */
  usage?: { input: number; output: number; cachedInput?: number; cacheCreation?: number };
}

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface ToolExecutionResult {
  toolCall: ToolCall;
  output: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latency: number;
  sample?: string;
  error?: string;
}

/**
 * 厂商能力表的一条记录。是 vendor adapter 的"事实来源"，
 * 避免调度层散落 if (provider === "kimi")。
 */
export interface ProviderCapability {
  id: string;
  displayName: string;
  transport: Transport;
  baseUrl: string;
  authStyle: AuthStyle;
  /** Anthropic-compatible endpoints sometimes require a different auth header. */
  anthropicAuthStyle?: AuthStyle;
  defaultModel: string;
  supportsTools: boolean;
  supportsThinking: boolean;
  thinkingField: ThinkingField;
  cacheStrategy: CacheStrategy;
  testStrategy: TestStrategy;
  /** 是否支持视觉（图片）输入。非多模态模型禁止走 read_image。 */
  supportsVision: boolean;
  /** Supported must-call wire policies; Adapter maps required to OpenAI required / Anthropic any. */
  toolChoiceModes?: ReadonlyArray<"named" | "required" | "auto" | "omit">;
  /**
   * 该厂商支持的协议清单（来自 docs/vendors 协议矩阵）。
   * 仅用于新建档案时预填默认值 + UI 提示文案，**不拦截**用户在下拉框的选择——
   * 用户填什么协议就走什么协议（自定义端点/中转站自行负责兼容性）。
   * 不标 = 未核实，UI 按"仅 capability.transport"提示。
   */
  supportedTransports?: readonly Transport[];
  /**
   * Responses transport：端点是否按 OpenAI 官方语义支持
   * `include: ["reasoning.encrypted_content"]`（store:false 下多轮回放加密 reasoning）。
   * capability 标记只是必要条件；运行时还需 baseUrl 为 OpenAI 官方域名（api.openai.com）
   * 才真正下发 include——中转站/第三方兼容端不发，避免报参数错误。
   */
  responsesEncryptedReasoning?: boolean;
  /**
   * 视觉模型的 OpenAI 兼容 baseUrl。仅当主聊天走 Anthropic 入口、视觉需走 OpenAI 入口时才需要标
   * （如 MiniMax 主配 /anthropic，视觉要走 /v1）。不标 = 视觉用主配置 baseUrl。
   */
  visionBaseUrl?: string;
  /** UI 是否允许选择（Claude 等 Anthropic adapter 未就绪前先禁用）。 */
  disabled?: boolean;
}

/** 调度层只看到这一层接口。 */
export interface ChatVendorAdapter {
  readonly id: string;
  readonly transport: Transport;
  capability: ProviderCapability;
  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest;
  parseResponse(raw: unknown): ChatResponse;
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[];
  applyCacheHints?(req: ChatRequest, cfg: VendorConfig): ChatRequest;
  /**
   * 流式 buildRequest：与 buildRequest 同形，但 stream=true 已写进 body。
   * 默认实现：复用 buildRequest（adapter 内部已经按 req.stream 写 body）。
   */
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest;
  /**
   * 解析一个完整流式事件。纯函数，无状态——状态由调用方持有的 buffer 维护。
   * 返回 null 表示这一事件不产生增量（心跳、注释行、未识别的 event type 等）。
   *
   * 命名严格对齐 StreamEvent：传进来的是 Reader 切完的"一个完整的协议事件"，
   * 不是字节片段（Chunk）。
   */
  parseStreamEvent(event: StreamEvent): StreamChunk | null;
  testConnection(cfg: VendorConfig): Promise<TestConnectionResult>;
}
