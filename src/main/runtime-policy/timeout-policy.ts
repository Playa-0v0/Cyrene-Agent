/**
 * Timeout Policy — 统一管理各调用场景的超时策略。
 *
 * 按调用场景命名，不按数字分组。
 * 30s Memory LLM 和 30s TTS 语义不同，不会因为数字相同就被合并。
 *
 * 覆盖优先级（高 → 低）：
 *   1. 单次调用 override
 *   2. 阶段默认值
 *
 * 使用方式：
 *   const policy = resolveTimeoutPolicy({ stage: "memory-llm" });
 *   const timer = setTimeout(() => controller.abort(), policy.totalMs);
 */

// ── 类型 ──

export type RuntimeTimeoutStage =
  | "memory-llm"
  | "tool-execution"
  | "tts-minimax"
  | "tts-gptsovits"
  | "tts-custom-cloud"
  | "tts-mossland"
  | "asr-mossland"
  | "external-http"
  | "vision-caption"
  | "call-management";

export interface TimeoutPolicy {
  /** 总超时（毫秒）。非流式调用主要使用此字段。 */
  totalMs: number;
  /** 首字节超时（毫秒）。流式模型首 token 等待上限。暂未启用。 */
  firstResponseMs?: number;
  /** 空闲超时（毫秒）。流式模型两次 chunk 之间的最大间隔。暂未启用。 */
  idleMs?: number;
}

export interface ResolveTimeoutPolicyOptions {
  stage: RuntimeTimeoutStage;
  /** 单次调用覆盖。只覆盖指定字段，未指定的字段保留阶段默认值。 */
  override?: Partial<TimeoutPolicy>;
}

// ── 阶段默认值 ──
// 这些值是从现有代码中提取的当前行为，不是新设计。

const STAGE_DEFAULTS: Record<RuntimeTimeoutStage, TimeoutPolicy> = {
  "memory-llm": {
    // memory-judge.ts, memory-compressor.ts：30s
    totalMs: 30_000,
  },
  "tool-execution": {
    // built-in-tools.ts SHELL_TIMEOUT_MS：5min
    totalMs: 5 * 60_000,
  },
  "tts-minimax": {
    // minimax-engine.ts WebSocket 超时：30s
    totalMs: 30_000,
  },
  "tts-gptsovits": {
    // gptsovits-engine.ts DEFAULT_TIMEOUT_MS：3 分钟（本地推理可能较慢，长文本需要更久）
    totalMs: 180_000,
  },
  "tts-custom-cloud": {
    // custom-cloud-engine.ts DEFAULT_TIMEOUT_MS：30s
    totalMs: 30_000,
  },
  "tts-mossland": {
    // mossland-engine.ts DEFAULT_TIMEOUT_MS：30s
    totalMs: 30_000,
  },
  "asr-mossland": {
    // mossland-asr-engine.ts 同步上传一轮语音并等待完整转写：30s
    totalMs: 30_000,
  },
  "external-http": {
    // life-tools.ts 翻译等外部 HTTP 调用：30s
    totalMs: 30_000,
  },
  "vision-caption": {
    // vision-captioner.ts VISION_TIMEOUT_MS：30s
    totalMs: 30_000,
  },
  "call-management": {
    // call-manager.ts 通话 LLM 请求：30s
    totalMs: 30_000,
  },
};

// ── Resolver ──

/**
 * 解析指定阶段的超时策略。
 *
 * 覆盖链：override → stage default。
 * override 只覆盖指定字段，未指定的保留阶段默认值。
 */
export function resolveTimeoutPolicy(options: ResolveTimeoutPolicyOptions): TimeoutPolicy {
  const defaults = STAGE_DEFAULTS[options.stage];

  if (!options.override) {
    return defaults;
  }

  return {
    totalMs: options.override.totalMs ?? defaults.totalMs,
    firstResponseMs: options.override.firstResponseMs ?? defaults.firstResponseMs,
    idleMs: options.override.idleMs ?? defaults.idleMs,
  };
}

/**
 * 获取指定阶段的完整策略（只读）。供诊断用。
 */
export function getStageTimeoutPolicy(stage: RuntimeTimeoutStage): Readonly<TimeoutPolicy> {
  return STAGE_DEFAULTS[stage];
}
