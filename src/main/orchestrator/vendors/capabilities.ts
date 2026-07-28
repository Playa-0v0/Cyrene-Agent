// 厂商能力表 —— vendor adapter 的唯一事实来源。
// 每条字段以 docs/vendors/tool-calling-matrix.md 为准；matrix 没核实的留保守默认值。
// displayName 必须与 renderer settings.ts 的 MODEL_PRESETS.providerName 完全一致。
import { ProviderCapability } from "./types";

export const PROVIDER_CAPABILITIES = [
  {
    id: "minimax",
    displayName: "MiniMax（稀宇科技）",
    // 默认走 OpenAI 兼容入口；Anthropic 入口仍可由用户显式选择。
    transport: "openai",
    baseUrl: "https://api.minimaxi.com/v1",
    authStyle: "bearer",
    defaultModel: "MiniMax-M3",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // M3 原生多模态（image_url / video_url）
    supportsVision: true,
    // 视觉同样走 OpenAI 兼容入口。
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
    // 文档未明示视觉版，默认模型不支持
    supportsVision: false,
  },
  {
    id: "doubao",
    displayName: "豆包（火山方舟）",
    transport: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authStyle: "bearer",
    defaultModel: "doubao-seed-2-1-pro-260628",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "none",
    testStrategy: "text",
    supportsVision: true,
  },
  {
    id: "glm",
    displayName: "GLM（智谱）",
    transport: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authStyle: "bearer",
    defaultModel: "glm-5.2",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 视觉版是 glm-5v-turbo，默认 glm-5.2 不支持
    supportsVision: false,
  },
  {
    id: "kimi",
    displayName: "Kimi（月之暗面）",
    // OpenAI 兼容 + prompt_cache_key + function.name 正则限制；baseUrl 必须是 .cn
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
    displayName: "Qwen（通义千问）",
    transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authStyle: "bearer",
    defaultModel: "qwen-max",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 视觉版是 qwen-vl 系列，默认 qwen-max 不支持
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
    // model 由用户填，保守 false；门控会按 supportsVision 拦截
    supportsVision: false,
  },
  {
    id: "claude",
    displayName: "Claude（Anthropic）",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "x-api-key",
    defaultModel: "claude-sonnet-4-6",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // Claude 支持多模态 image content block
    supportsVision: true,
  },
  {
    id: "mimo",
    displayName: "MiMo（小米）",
    // 默认入口：用户切 /anthropic 时由 detectTransport 自动推断
    transport: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1",
    // 官方文档：/v1 与 /anthropic 都支持 Authorization: Bearer
    authStyle: "bearer",
    defaultModel: "mimo-v2.5-pro",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    supportsVision: true,
    // 结构上独立：用户切主入口到 /anthropic 时视觉仍由 visionBaseUrl 决定
    visionBaseUrl: "https://api.xiaomimimo.com/v1",
  },
] satisfies readonly ProviderCapability[];

const byDisplayName = new Map(PROVIDER_CAPABILITIES.map(c => [c.displayName, c]));

export function getCapability(provider: string): ProviderCapability | undefined {
  return byDisplayName.get(provider);
}

/** 兜底：未知厂商按 OpenAI 兼容处理（保守可用），避免直接崩。 */
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
