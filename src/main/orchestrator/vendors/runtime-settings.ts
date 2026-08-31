import { getCustomEndpointMode } from "../../../shared/custom-endpoint-state";

/**
 * Vendor adapter 在请求构建期能读取的"运行时"开关。
 *
 * 通过 setVendorRuntimeSettingsGetter 注入 getter（main/index.ts），
 * adapter 内调用 getVendorRuntimeSettings() 实时拿值，避免反向依赖主进程入口。
 *
 * 注意：thinkingOverride / disableMaxToken **仅对自定义端点生效**，
 * preset 厂商由 capability 表（src/shared/reasoning.ts）+ chat 下拉控制：
 *   - thinkingOverride 在 preset 厂商下基本被 capability 接管，是花瓶/误导
 *   - disableMaxToken 在 Anthropic 厂商下会让 Claude 主聊天因缺 max_tokens 字段直接 400
 */
export interface VendorRuntimeSettings {
  thinkingOverride?: -1 | 0 | 1;
  disableMaxToken?: boolean;
}

/** resolver 的最小输入快照——只取 getter 实际读的两个字段。 */
export interface VendorRuntimeSettingsSource {
  provider: string;
  thinkingOverride?: -1 | 0 | 1;
  disableMaxToken?: boolean;
}

let settingsGetter: (() => VendorRuntimeSettings) | null = null;

export function setVendorRuntimeSettingsGetter(
  getter: () => VendorRuntimeSettings,
): void {
  settingsGetter = getter;
}

export function getVendorRuntimeSettings(): VendorRuntimeSettings {
  return settingsGetter?.() ?? {};
}

/**
 * 把 ModelSettings 的相关字段解析为 VendorRuntimeSettings。
 *
 * 规则：
 *   - provider 命中自定义端点（云端/本地）→ 原样透传
 *   - preset 厂商 → thinkingOverride 强制 0，disableMaxToken 强制 false
 *     （保留磁盘上用户原值不动，仅屏蔽其效果）
 *
 * 纯函数，方便测试。
 */
export function resolveVendorRuntimeSettings(
  source: VendorRuntimeSettingsSource,
): VendorRuntimeSettings {
  const isCustomEndpoint = getCustomEndpointMode(source.provider) !== null;
  if (isCustomEndpoint) {
    return {
      thinkingOverride: source.thinkingOverride,
      disableMaxToken: source.disableMaxToken,
    };
  }
  return {
    thinkingOverride: 0,
    disableMaxToken: false,
  };
}