// 廠商能力表 —— vendor adapter 的唯一事實來源。
// 每條字段以 docs/vendors/tool-calling-matrix.md 為準；matrix 沒核實的留保守默認值。
// displayName 必須與 renderer settings.ts 的 MODEL_PRESETS.providerName 完全一致。
import { ProviderCapability } from "./types";

export const PROVIDER_CAPABILITIES: ProviderCapability[] = [
  {
    id: "minimax",
    displayName: "MiniMax（稀宇科技）",
    // 主推 Anthropic 兼容入口；多輪 tool_calls 必須完整回傳 thinking/reasoning_details
    transport: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    authStyle: "x-api-key",
    defaultModel: "MiniMax-M3",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // M3 原生多模態（image_url / video_url）
    supportsVision: true,
    // 主配走 /anthropic（Anthropic 入口），但視覺要走 OpenAI 入口 /v1。
    // 同步主模型時用這個 baseUrl，避免用戶手動改。
    visionBaseUrl: "https://api.minimaxi.com/v1",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek（深度求索）",
    transport: "openai",
    baseUrl: "https://api.deepseek.com",
    authStyle: "bearer",
    defaultModel: "deepseek-v4-pro",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 文檔未明示視覺版，默認模型不支持
    supportsVision: false,
  },
  {
    id: "volcengine",
    displayName: "火山 AgentPlan（火山引擎）",
    // OpenAI 兼容 + 專屬 baseUrl + 可選 reasoning_content；不為它單獨寫 transport
    transport: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    authStyle: "bearer",
    defaultModel: "ark-code-latest",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "none",
    testStrategy: "text",
    // 火山方舟是聚合平臺，可路由到 doubao-seed 等多模態子模型；支持視覺
    supportsVision: true,
  },
  {
    id: "glm",
    displayName: "GLM（智譜）",
    transport: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authStyle: "bearer",
    defaultModel: "glm-5.2",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 視覺版是 glm-5v-turbo，默認 glm-5.2 不支持
    supportsVision: false,
  },
  {
    id: "kimi",
    displayName: "Kimi（月之暗面）",
    // OpenAI 兼容 + prompt_cache_key + function.name 正則限制；baseUrl 必須是 .cn
    transport: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    authStyle: "bearer",
    defaultModel: "kimi-k2.7-code",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "prompt_cache_key",
    testStrategy: "text",
    // k2.7-code 支持 image_url / video_url content block
    supportsVision: true,
  },
  {
    id: "qwen",
    displayName: "Qwen（通義千問）",
    transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authStyle: "bearer",
    defaultModel: "qwen-max",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 視覺版是 qwen-vl 系列，默認 qwen-max 不支持
    supportsVision: false,
  },
  {
    id: "chatgpt",
    displayName: "ChatGPT（OpenAI）",
    transport: "openai",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "bearer",
    defaultModel: "",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // model 由用戶填，支持自定義多模態模型（如 gpt-4o / gemini）
    supportsVision: true,
  },
  {
    id: "claude",
    displayName: "Claude（Anthropic）",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "x-api-key",
    defaultModel: "",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // Claude 支持多模態 image content block，但 adapter 當前 disabled
    supportsVision: true,
    disabled: true,
  },
];

const byDisplayName = new Map(PROVIDER_CAPABILITIES.map(c => [c.displayName, c]));

export function getCapability(provider: string): ProviderCapability | undefined {
  return byDisplayName.get(provider);
}

/** 兜底：未知廠商按 OpenAI 兼容處理（保守可用），避免直接崩。 */
export function getCapabilityOrOpenAI(provider: string): ProviderCapability {
  return byDisplayName.get(provider) ?? {
    id: "unknown",
    displayName: provider,
    transport: "openai",
    baseUrl: "",
    authStyle: "bearer",
    defaultModel: "",
    supportsTools: true,
    supportsThinking: false,
    thinkingField: null,
    cacheStrategy: "none",
    testStrategy: "text",
    supportsVision: false,
  };
}
