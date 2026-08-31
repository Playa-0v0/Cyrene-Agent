/**
 * 模型配置统一入口
 *
 * 其他模块通过此模块读取模型运行时配置，不直接访问 index.ts 的内部定义。
 */

export { DEFAULT_CONTEXT_WINDOW_TOKENS } from "./model-settings.defaults";
export type { ModelRuntimeProfile } from "./model-runtime-profile";
