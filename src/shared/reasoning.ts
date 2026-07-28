// 厂商无关的推理控制层 —— 类型 + 规则表 + resolver + normalize
//
// 适用范围：仅推理模式 auto/off/on + 真实存在的 effort 档位。
// 不涉及温度 / Top-P / max_tokens / verbosity / thinking_budget / Responses API。
//
// 调用方：
//   - renderer/settings.ts：UI 显示与状态文案（调 resolveEffectiveReasoning）
//   - main/orchestrator/vendors/*-adapter.ts：buildRequest 内转换请求体
//     （调 resolveReasoningCapability + applyReasoningPreference）
//   - main/orchestrator/vendors/reasoning.ts：纯函数 applyReasoningPreference
//
// providerId 必须与 main/orchestrator/vendors/capabilities.ts 的 ProviderCapability.id
// 完全一致：chatgpt / claude / deepseek / glm / kimi / qwen / minimax / mimo / doubao / unknown。
//
// 规则优先级：第一条匹配的 capability 生效（find() + first-match-wins）。
// 排序原则：具体型号在前，宽泛系列在后（Qwen /-thinking$/ 必须在 /^qwen3/ 之前；
// Kimi K2.5/K2.6/K2.7-Code/K2.7-Code-HighSpeed 必须用精确正则，且 K2.7 系列
// 必须在通用 kimi-k2-thinking 系列之前）。

export type ReasoningMode = "auto" | "off" | "on";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningControl =
  | "none"
  | "toggle"
  | "effort"
  | "toggle-effort"
  | "fixed-on"
  | "dynamic";

export type ReasoningRequestStyle =
  | "openai-effort"
  | "thinking-type"
  | "anthropic-adaptive"
  | "qwen-enable-thinking"
  | "none";

export interface ReasoningCapability {
  control: ReasoningControl;
  supportedEfforts?: readonly ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  requestStyle: ReasoningRequestStyle;
  /**
   * 该 capability 是否支持显式关闭（off）。
   * OpenAI 各型号按具体规则声明（gpt-5.6 = true，o1 = true，gpt-4o 兜底 = false）。
   * supportsDisable=false 时 UI 不显示"关闭"按钮，请求也不发 reasoning_effort:"none"。
   */
  supportsDisable: boolean;
  /**
   * 仅 thinking-type 适用：是否在 on + hasTools 时附加 thinking.keep="all"。
   * Kimi K2.6 = true；K2.5 = false。
   */
  keepOnTools?: boolean;
}

export interface ReasoningPreference {
  mode: ReasoningMode;
  effort?: ReasoningEffort;
}

export interface ModelReasoningRule {
  providerId: string;
  modelPattern: RegExp;
  capability: ReasoningCapability;
}

/** 兜底 capability：未知 provider / 模型 */
const UNKNOWN_CAPABILITY: ReasoningCapability = {
  control: "none",
  requestStyle: "none",
  supportsDisable: false,
};

/**
 * 9 家厂商规则表。第一条匹配的 capability 生效。
 *
 * 修改本表前请同步更新：
 *   - src/shared/reasoning.test.ts（A. 规则匹配优先级 + B. 9 家全部存在性）
 *   - 桌面 2026-07-14-reasoning-control-layer-design.md §3.2
 */
export const MODEL_REASONING_RULES: readonly ModelReasoningRule[] = [
  // ── chatgpt（OpenAI）──
  // 按具体型号拆分；GPT-5.6 当前 Chat Completions 接受 low/medium/high/xhigh/max
  // （不含 minimal）；supportsDisable=true，off → reasoning_effort:"none"。
  { providerId: "chatgpt", modelPattern: /^gpt-5\.6/i, capability: {
    control: "effort",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    requestStyle: "openai-effort",
    supportsDisable: true,
  } },
  { providerId: "chatgpt", modelPattern: /^gpt-5/i, capability: {
    control: "effort",
    supportedEfforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
    requestStyle: "openai-effort",
    supportsDisable: true,
  } },
  { providerId: "chatgpt", modelPattern: /^o1/i, capability: {
    control: "effort",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    requestStyle: "openai-effort",
    supportsDisable: true,
  } },
  { providerId: "chatgpt", modelPattern: /^o3/i, capability: {
    control: "effort",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    requestStyle: "openai-effort",
    supportsDisable: true,
  } },
  { providerId: "chatgpt", modelPattern: /^o4/i, capability: {
    control: "effort",
    supportedEfforts: ["medium", "high"],
    defaultEffort: "medium",
    requestStyle: "openai-effort",
    supportsDisable: true,
  } },
  { providerId: "chatgpt", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── claude（Anthropic）──
  { providerId: "claude", modelPattern: /^claude-fable-5/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    requestStyle: "anthropic-adaptive",
    supportsDisable: true,
  } },
  { providerId: "claude", modelPattern: /^claude-sonnet-5/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    requestStyle: "anthropic-adaptive",
    supportsDisable: true,
  } },
  { providerId: "claude", modelPattern: /^claude-opus-4-(8|7|6)/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    requestStyle: "anthropic-adaptive",
    supportsDisable: true,
  } },
  { providerId: "claude", modelPattern: /^claude-sonnet-4-6/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    requestStyle: "anthropic-adaptive",
    supportsDisable: true,
  } },
  { providerId: "claude", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── deepseek ──
  { providerId: "deepseek", modelPattern: /^deepseek-v4/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["high", "max"],
    defaultEffort: "high",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "deepseek", modelPattern: /^deepseek-(chat|reasoner)$/i, capability: UNKNOWN_CAPABILITY },
  { providerId: "deepseek", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── glm（智谱）──
  // 精确型号在前；glm-5 基础型号放在精确型号之后（兜底更宽的 glm-5 系列）。
  { providerId: "glm", modelPattern: /^glm-5\.2/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["high", "max"],
    defaultEffort: "high",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "glm", modelPattern: /^glm-5-turbo$/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "glm", modelPattern: /^glm-5v-turbo$/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "glm", modelPattern: /^glm-5\.1/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "glm", modelPattern: /^glm-5/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "glm", modelPattern: /^glm-(4\.5|4\.6|4\.7)/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "glm", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── qwen（通义千问）──
  // /-thinking$/ 必须在 /^qwen3/ 之前。
  { providerId: "qwen", modelPattern: /-thinking$/i, capability: {
    control: "fixed-on",
    requestStyle: "none",
    supportsDisable: false,
  } },
  { providerId: "qwen", modelPattern: /^qwen3/i, capability: {
    control: "toggle",
    requestStyle: "qwen-enable-thinking",
    supportsDisable: true,
  } },
  { providerId: "qwen", modelPattern: /^qwen-(max|plus|turbo)/i, capability: {
    control: "toggle",
    requestStyle: "qwen-enable-thinking",
    supportsDisable: true,
  } },
  { providerId: "qwen", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── kimi（月之暗面）──
  // K2.7-Code / K2.7-Code-HighSpeed 必须用精确正则（$-anchor），
  // 且排在通用 kimi-k2-thinking 系列之前。
  { providerId: "kimi", modelPattern: /^kimi-k2\.7-code-highspeed$/i, capability: {
    control: "fixed-on",
    requestStyle: "none",
    supportsDisable: false,
  } },
  { providerId: "kimi", modelPattern: /^kimi-k2\.7-code$/i, capability: {
    control: "fixed-on",
    requestStyle: "none",
    supportsDisable: false,
  } },
  { providerId: "kimi", modelPattern: /^kimi-k2\.6/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
    keepOnTools: true,
  } },
  { providerId: "kimi", modelPattern: /^kimi-k2\.5/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
    keepOnTools: false,
  } },
  { providerId: "kimi", modelPattern: /^kimi-k2-thinking/i, capability: {
    control: "fixed-on",
    requestStyle: "none",
    supportsDisable: false,
  } },
  { providerId: "kimi", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── minimax（稀宇科技）──
  // M3 走 anthropic-adaptive（on=adaptive / off=disabled），不用通用 thinking-type 路径。
  { providerId: "minimax", modelPattern: /^MiniMax-M3/i, capability: {
    control: "toggle",
    requestStyle: "anthropic-adaptive",
    supportsDisable: true,
  } },
  { providerId: "minimax", modelPattern: /^MiniMax-M2\./i, capability: {
    control: "fixed-on",
    requestStyle: "none",
    supportsDisable: false,
  } },
  { providerId: "minimax", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── mimo（小米）──
  // 跨 transport 共用：OpenAI 入口 + Anthropic 入口都生成 thinking.type。
  { providerId: "mimo", modelPattern: /^mimo-v2\./i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "mimo", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },

  // ── doubao（火山方舟）──
  { providerId: "doubao", modelPattern: /^doubao-seed-/i, capability: {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  } },
  { providerId: "doubao", modelPattern: /.*/, capability: UNKNOWN_CAPABILITY },
];

/**
 * 按 (providerId, model) 解析推理 capability。
 * 未命中任何规则时返回兜底 { control: "none", requestStyle: "none", supportsDisable: false }。
 */
export function resolveReasoningCapability(
  providerId: string,
  model: string,
): ReasoningCapability {
  for (const rule of MODEL_REASONING_RULES) {
    if (rule.providerId === providerId && rule.modelPattern.test(model)) {
      return rule.capability;
    }
  }
  return UNKNOWN_CAPABILITY;
}

/**
 * 把用户 preference 解析为 effective preference。
 *
 * 决策顺序（用户第三轮修订 #3）：
 * 1. control = none / dynamic → 强制 auto
 * 2. control = fixed-on → 永远返 { mode: "on" }，不读 pref.mode、不读 pref.effort
 * 3. control ∈ {toggle, effort, toggle-effort}：
 *    - mode !== "on" → 直接返 { mode }，不保留 effort
 *    - mode === "on"：effort 不在 supportedEfforts → 退回 defaultEffort；
 *      effort 缺省时填 defaultEffort；defaultEffort 也不在列 → 丢弃 effort
 *
 * 注意：saved 永远不动（用户修订 #5），effective 仅用于运行时请求与 UI 当前显示。
 */
export function resolveEffectiveReasoning(
  preference: ReasoningPreference | undefined,
  capability: ReasoningCapability,
  thinkingOverride?: -1 | 0 | 1,
): ReasoningPreference {
  const pref = preference ?? { mode: "auto" };

  // 1. 不支持 / 动态路由 → 强制 auto
  if (thinkingOverride === -1 || (thinkingOverride !== 1 && (capability.control === "none" || capability.control === "dynamic"))) {
    return { mode: "auto" };
  }

  // 2. fixed-on：effective 永远 on
  if (capability.control === "fixed-on") {
    return { mode: "on" };
  }

  // 3. toggle / effort / toggle-effort
  const { mode } = pref;

  // mode !== "on" → 不保留 effort（第三轮修订 #3）
  if (mode !== "on") {
    return { mode };
  }

  let { effort } = pref;

  // effort 不在 supportedEfforts → 退回 defaultEffort
  if (effort !== undefined && capability.supportedEfforts && !capability.supportedEfforts.includes(effort)) {
    effort = capability.defaultEffort;
  }

  // effort 缺省时填 defaultEffort
  if (effort === undefined && capability.defaultEffort) {
    effort = capability.defaultEffort;
  }

  return { mode, ...(effort !== undefined ? { effort } : {}) };
}

// ── normalize 白名单（用户修订 #4：白名单，不 trim）──

const MODE_SET: ReadonlySet<ReasoningMode> = new Set(["auto", "off", "on"]);
const EFFORT_SET: ReadonlySet<ReasoningEffort> = new Set([
  "minimal", "low", "medium", "high", "xhigh", "max",
]);

/**
 * 把任意 input 归一化为合法 { mode, effort? }。
 * - 完全非法对象 → undefined
 * - mode 非法 → undefined
 * - mode 合法但 effort 非法 → 返 { mode }，effort 字段丢弃
 * - 完全合法 → 原样
 */
export function normalizeReasoningPreference(
  input: unknown,
): { mode: ReasoningMode; effort?: ReasoningEffort } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as { mode?: unknown; effort?: unknown };
  if (typeof obj.mode !== "string" || !MODE_SET.has(obj.mode as ReasoningMode)) {
    return undefined;
  }
  const mode = obj.mode as ReasoningMode;
  if (obj.effort === undefined || obj.effort === null) {
    return { mode };
  }
  if (typeof obj.effort !== "string" || !EFFORT_SET.has(obj.effort as ReasoningEffort)) {
    return { mode };
  }
  return { mode, effort: obj.effort as ReasoningEffort };
}

/**
 * 持久化折叠（用户第三轮修订 #4）：
 *
 * 语义：
 * - hasIncomingKey=false（字段缺失）→ 保留旧值（不覆盖）
 * - hasIncomingKey=true 且 incomingRaw 为 undefined / null → 视作"用户主动清空" → 返 undefined
 * - hasIncomingKey=true 且 incomingRaw 为非法对象 → normalize 后 undefined → 保留旧值（防覆盖）
 * - hasIncomingKey=true 且合法对象 → 用新值
 *
 * 调用方负责传入正确的 hasIncomingKey（区分 "settings 里没这个字段" vs "settings 里显式 undefined"）。
 * hasOwnProperty 是判断字段缺失的标准方式。
 */
export function foldReasoning(
  incomingRaw: unknown,
  existing: ReasoningPreference | undefined,
  hasIncomingKey: boolean,
): ReasoningPreference | undefined {
  if (!hasIncomingKey) return existing;
  if (incomingRaw === undefined || incomingRaw === null) return undefined;
  const normalized = normalizeReasoningPreference(incomingRaw);
  if (normalized === undefined) return existing;
  return normalized;
}
