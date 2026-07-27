// 廠商工具調用適配層 —— 統一類型
// 調度層（function-calling.ts）只依賴這裡的統一結構，絕不出現 if (provider === "xxx")。
// 協議事實來源：docs/vendors/tool-calling-matrix.md

export type Transport = "openai" | "anthropic";
export type AuthStyle = "bearer" | "x-api-key";
export type ThinkingField = "reasoning_content" | "thinking" | "reasoning_details" | null;
export type CacheStrategy = "prompt_cache_key" | "cache_control" | "auto" | "none";
export type TestStrategy = "text" | "text+tool";

/** 調度層傳入適配器的廠商運行時配置（結構兼容 main/index.ts 的 ModelSettings）。 */
export interface VendorConfig {
  provider: string; // 廠商顯示名，如 "MiniMax（稀宇科技）"，與 capability 表的 displayName 對齊
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 用戶在 settings UI 顯式指定的 transport；"auto" 走 baseUrl 啟發式 + capabilities fallback。
   * resolveTransport(cfg) 負責把 auto 解析為具體 transport。
   */
  explicitTransport?: Transport | "auto";
}

/** 統一工具調用描述（項目內部），與 OpenAI/Anthropic wire 格式解耦。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串，沿用 OpenAI 習慣
}

/**
 * 統一消息結構。兩個 transport 各自只讀自己需要的字段，調度層透傳。
 * - OpenAI transport 讀 content / toolCalls / toolCallId / name
 * - Anthropic transport 額外讀 thinking / rawAssistant（多輪必須原樣回傳 content block 數組）
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  /** assistant 上的工具調用（統一結構，OpenAI wire 再轉成 tool_calls[].function）。 */
  toolCalls?: ToolCall[];
  /** role:"tool" 的回填錨點（OpenAI: tool_call_id；Anthropic: tool_use_id）。 */
  toolCallId?: string;
  name?: string;
  /** 思考/推理純文本（reasoning_content / thinking block 抽出來）。 */
  thinking?: string;
  /** Anthropic 多輪必須原樣回傳 assistant.content block 數組；OpenAI transport 不讀。 */
  rawAssistant?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  stream?: boolean;
  /**
   * 非流式調用時的 max_tokens 上限（OpenAI wire: `max_tokens`；Anthropic wire 覆蓋默認 4096）。
   * 流式時由 adapter 決定是否使用（通常不用——流式靠 finish_reason 判斷）。
   */
  maxTokens?: number;
  /** 透傳到請求體頂層的廠商擴展字段（如 Kimi 的 prompt_cache_key）。 */
  extraBody?: Record<string, unknown>;
}

/**
 * Transport-無關的統一流式事件。
 * Reader 層（createSseReader）把 HTTP body 字節流切分成 StreamEvent 列表；
 * Adapter 層 parseStreamEvent(event) 是純函數，無狀態。
 *
 * - OpenAI 流式：Reader 切出的 eventType 固定為 "data"，data 是 data: {...} 行的 JSON 字符串。
 * - Anthropic 流式：eventType 是事件名（message_start / content_block_delta / message_delta /
 *   message_stop 等），data 是 data: {...} 行的 JSON 字符串。
 */
export interface StreamEvent {
  eventType: string;
  data: string;
}

/**
 * 流式增量塊。接口設計比當前需求寬（保留 deltaToolCalls），
 * 但本次兩個 adapter 的 parseStreamEvent 實現只解析 deltaText + deltaThinking；
 * 遇到 tool delta 時靜默忽略（不報錯、不累積）。
 *
 * 未來若 MemoryJudge / 心情觀察器想走工具調用，只改 adapter 實現，
 * 不改接口、不改調用方。
 */
export interface StreamChunk {
  deltaText?: string;
  deltaThinking?: string;
  deltaToolCalls?: ToolCall[];
  done?: boolean;
  usage?: { input: number; output: number };
}

/** 適配器解析後的統一響應，調度層只看這個。 */
export interface ChatResponse {
  /** 要追加進對話的 assistant 消息（保留 thinking / rawAssistant 供下輪迴傳）。 */
  assistantMessage: ChatMessage;
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  finishReason: string;
  raw: unknown;
  /** API 返回的 token 用量（OpenAI: prompt_tokens/completion_tokens；Anthropic: input_tokens/output_tokens）。
   *  未上報時為 undefined，由調用方兜底。 */
  usage?: { input: number; output: number };
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
 * 廠商能力表的一條記錄。是 vendor adapter 的"事實來源"，
 * 避免 function-calling.ts 裡散落 if (provider === "kimi")。
 */
export interface ProviderCapability {
  id: string;
  displayName: string;
  transport: Transport;
  baseUrl: string;
  authStyle: AuthStyle;
  defaultModel: string;
  supportsTools: boolean;
  supportsThinking: boolean;
  thinkingField: ThinkingField;
  cacheStrategy: CacheStrategy;
  testStrategy: TestStrategy;
  /** 是否支持視覺（圖片）輸入。非多模態模型禁止走 read_image。 */
  supportsVision: boolean;
  /**
   * 視覺模型的 OpenAI 兼容 baseUrl。僅當主聊天走 Anthropic 入口、視覺需走 OpenAI 入口時才需要標
   * （如 MiniMax 主配 /anthropic，視覺要走 /v1）。不標 = 視覺用主配置 baseUrl。
   */
  visionBaseUrl?: string;
  /** UI 是否允許選擇（Claude 等 Anthropic adapter 未就緒前先禁用）。 */
  disabled?: boolean;
}

/** 調度層只看到這一層接口。 */
export interface ChatVendorAdapter {
  readonly id: string;
  readonly transport: Transport;
  capability: ProviderCapability;
  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest;
  parseResponse(raw: unknown): ChatResponse;
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[];
  applyCacheHints?(req: ChatRequest, cfg: VendorConfig): ChatRequest;
  /**
   * 流式 buildRequest：與 buildRequest 同形，但 stream=true 已寫進 body。
   * 默認實現：複用 buildRequest（adapter 內部已經按 req.stream 寫 body）。
   */
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest;
  /**
   * 解析一個完整流式事件。純函數，無狀態——狀態由調用方持有的 buffer 維護。
   * 返回 null 表示這一事件不產生增量（心跳、註釋行、未識別的 event type 等）。
   *
   * 命名嚴格對齊 StreamEvent：傳進來的是 Reader 切完的"一個完整的協議事件"，
   * 不是字節片段（Chunk）。
   */
  parseStreamEvent(event: StreamEvent): StreamChunk | null;
  testConnection(cfg: VendorConfig): Promise<TestConnectionResult>;
}
