import type { PluginHostError, PluginHostErrorCode } from "../../plugins/api";

export interface PluginHostErrorOptions {
  /** 内部异常：只记录到宿主日志，不挂到公开错误对象上。 */
  cause?: unknown;
  /** 日志前缀，例如 plugin:<id>:secrets。 */
  logPrefix?: string;
}

/**
 * 宿主服务的统一错误创建入口。插件只应依赖 code 做分支处理，
 * message 文案不保证稳定；内部 cause 只进宿主日志，
 * 不随错误对象透传给插件。
 */
export function pluginHostError(
  code: PluginHostErrorCode,
  message: string,
  options?: PluginHostErrorOptions,
): PluginHostError {
  if (options?.cause !== undefined) {
    console.warn(`[${options.logPrefix ?? "plugin-host"}] ${code}: ${message}`, options.cause);
  }
  const error = new Error(message) as PluginHostError;
  error.code = code;
  return error;
}
