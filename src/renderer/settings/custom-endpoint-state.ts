export type CustomEndpointMode = "cloud" | "local";

export const CUSTOM_ENDPOINT_PROVIDERS = {
  cloud: "自定义端点（云端）",
  local: "自定义端点（本地）",
} as const;

export interface CustomEndpointPresentation {
  displayName: string;
  apiKeyOptional: boolean;
  baseUrlPlaceholder: string;
  transport: "openai";
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
    transport: "openai",
  },
  local: {
    displayName: "本地模型",
    apiKeyOptional: true,
    baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
    transport: "openai",
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
