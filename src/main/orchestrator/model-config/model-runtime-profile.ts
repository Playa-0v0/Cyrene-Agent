/**
 * 模型运行时配置（从 ModelSettings 中提取的运行时相关字段）
 *
 * 其他模块统一通过 ModelRuntimeProfile 读取模型运行时配置，
 * 不直接访问 ModelSettings 的内部字段。
 *
 * ModelSettingsLite 应使用 Pick<ModelSettings, ...> 避免手动同步。
 */

/**
 * 模型运行时配置子集。
 * 包含 Code 模式需要的模型相关字段。
 */
export interface ModelRuntimeProfile {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 上下文窗口大小（Token）。默认 256000，来自 DEFAULT_CONTEXT_WINDOW_TOKENS。 */
  contextWindowTokens: number;
}
