/**
 * 自定义端点状态 —— renderer 端入口。
 *
 * 类型/常量/纯函数已迁移到 src/shared/custom-endpoint-state.ts（main 进程也要用）。
 * 本文件保留 validateCustomEndpointConfig（依赖 DOM `URL` 检查，main 端不需要）。
 *
 * 旧 import 路径 "./custom-endpoint-state" 仍然兼容——所有公开 API 都在这里 re-export。
 */
export {
  CUSTOM_ENDPOINT_PROVIDERS,
  getCustomEndpointMode,
  getCustomEndpointPresentation,
  getCustomEndpointProvider,
  type CustomEndpointConfigInput,
  type CustomEndpointMode,
  type CustomEndpointPresentation,
} from "../../shared/custom-endpoint-state";

import type { CustomEndpointConfigInput, CustomEndpointMode } from "../../shared/custom-endpoint-state";

export function validateCustomEndpointConfig(
  mode: CustomEndpointMode,
  config: CustomEndpointConfigInput,
): string | null {
  const baseUrl = config.baseUrl.trim();
  if (!baseUrl) return "请填写 Base URL";

  try {
    const parsed = new URL(baseUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return "Base URL 必须是完整的 HTTP(S) 地址";
    }
  } catch {
    return "Base URL 必须是完整的 HTTP(S) 地址";
  }

  if (!config.model.trim()) return "请填写模型 ID";
  if (mode === "cloud" && !config.apiKey.trim()) return "请填写 API Key";
  return null;
}