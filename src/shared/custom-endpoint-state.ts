/**
 * 自定义端点状态 —— 跨进程共享的纯类型 + 常量 + 纯函数。
 *
 * CustomEndpointMode: 自定义端点的两种形态（云端/本地）。
 * CUSTOM_ENDPOINT_PROVIDERS: 写入 ModelSettings.provider 的字符串常量。
 * getCustomEndpointMode(provider): 判定 provider 是不是自定义端点。
 *
 * 注意：validateCustomEndpointConfig（涉及 DOM `URL` 检查）保留在 renderer 端，
 * 此文件只放跨进程可共享的纯数据 + 判定逻辑。
 */

export type CustomEndpointMode = "cloud" | "local";

export const CUSTOM_ENDPOINT_PROVIDERS = {
  cloud: "自定义端点（云端）",
  local: "自定义端点（本地）",
} as const;

export interface CustomEndpointPresentation {
  displayName: string;
  apiKeyOptional: boolean;
  baseUrlPlaceholder: string;
}

export interface CustomEndpointConfigInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const PRESENTATION: Record<CustomEndpointMode, CustomEndpointPresentation> = {
  cloud: {
    displayName: "自定义云端",
    apiKeyOptional: false,
    baseUrlPlaceholder: "https://your-provider.example/v1",
  },
  local: {
    displayName: "本地模型",
    apiKeyOptional: true,
    baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
  },
};

export function getCustomEndpointProvider(mode: CustomEndpointMode): string {
  return CUSTOM_ENDPOINT_PROVIDERS[mode];
}

export function getCustomEndpointMode(provider: string): CustomEndpointMode | null {
  if (provider === CUSTOM_ENDPOINT_PROVIDERS.cloud) return "cloud";
  if (provider === CUSTOM_ENDPOINT_PROVIDERS.local) return "local";
  return null;
}

export function getCustomEndpointPresentation(mode: CustomEndpointMode): CustomEndpointPresentation {
  return PRESENTATION[mode];
}