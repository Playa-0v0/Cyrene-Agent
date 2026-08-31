/**
 * Token Budget Policy — 统一管理各 LLM 阶段的 maxOutputTokens。
 *
 * 覆盖优先级（高 → 低）：
 *   1. 单次调用覆盖（override）
 *   2. Model Profile 覆盖 —— 未来按 provider/model 配置（暂未启用）
 *   3. 阶段默认值（stageDefaults）
 *
 * 使用方式：
 *   const maxTokens = resolveMaxOutputTokens({ stage: "task-plan", override: 2400 });
 */

// ── 类型 ──

export type RuntimeStage =
  | "task-plan"
  | "ask-soul"
  | "memory-judge"
  | "memory-compressor"
  | "memory-reflect"
  | "memory-resolver";

export interface TokenBudgetPolicy {
  /** 该阶段的默认最大输出 token 数 */
  defaultMaxOutputTokens: number;
  /** 可选：最小输出 token 数（防止用户覆盖过小） */
  minOutputTokens?: number;
  /** 可选：最大输出 token 数上限（防止用户覆盖过大） */
  maxOutputTokens?: number;
}

export interface ResolveTokenBudgetInput {
  stage: RuntimeStage;
  /** 单次调用覆盖（最高优先级）。 */
  override?: number;
  /** 未来扩展：按 provider/model 覆盖。暂不启用。 */
  providerModelKey?: string;
}

// ── 阶段默认值 ──
// 这些值是从现有代码中提取的当前行为，不是新设计。

const STAGE_DEFAULTS: Record<RuntimeStage, TokenBudgetPolicy> = {
  "task-plan": {
    defaultMaxOutputTokens: 1200,
  },
  "ask-soul": {
    defaultMaxOutputTokens: 1600,
  },
  "memory-judge": {
    defaultMaxOutputTokens: 800,
  },
  "memory-compressor": {
    defaultMaxOutputTokens: 500,
  },
  "memory-reflect": {
    defaultMaxOutputTokens: 500,
  },
  "memory-resolver": {
    defaultMaxOutputTokens: 700,
  },
};

// ── Resolver ──

/**
 * 解析指定阶段的 maxOutputTokens。
 *
 * 覆盖链：override → stage default。
 * 未来可插入 providerModelKey → Model Profile 层。
 */
export function resolveMaxOutputTokens(input: ResolveTokenBudgetInput): number {
  const policy = STAGE_DEFAULTS[input.stage];

  // 1. 单次调用覆盖
  if (input.override !== undefined && Number.isFinite(input.override) && input.override > 0) {
    const clamped = Math.round(input.override);
    if (policy.minOutputTokens !== undefined && clamped < policy.minOutputTokens) {
      return policy.minOutputTokens;
    }
    if (policy.maxOutputTokens !== undefined && clamped > policy.maxOutputTokens) {
      return policy.maxOutputTokens;
    }
    return clamped;
  }

  // 2. Model Profile 覆盖（暂未启用，预留接口）
  // if (input.providerModelKey) { ... }

  // 3. 阶段默认值
  return policy.defaultMaxOutputTokens;
}

/**
 * 获取指定阶段的完整策略（只读）。供诊断或 UI 展示用。
 */
export function getStageTokenPolicy(stage: RuntimeStage): Readonly<TokenBudgetPolicy> {
  return STAGE_DEFAULTS[stage];
}
