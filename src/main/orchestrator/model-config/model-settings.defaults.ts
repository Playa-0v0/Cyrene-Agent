/**
 * 模型运行时默认值
 *
 * DEFAULT_CONTEXT_WINDOW_TOKENS 是上下文窗口大小的唯一定义点。
 * 其他模块只能通过 ModelRuntimeProfile 读取，禁止重复写 256000。
 */

/** 默认上下文窗口大小（Token）。唯一定义点。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
