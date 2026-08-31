// API 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

import type { ApiTransport } from "../../../shared/api-endpoint";
import type { ReasoningPreference } from "../../../shared/reasoning";
import type { CustomEndpointMode } from "../custom-endpoint-state";

/** 档案卡上需要展示/编辑的最小字段集（来自 listModelProfiles）。 */
export interface SavedProfileLite {
  id: string;
  provider: string;
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: ApiTransport;
  reasoning?: ReasoningPreference;
  contextWindowTokens?: number;
  multimodal?: boolean;
}

export const apiState = {
  activeProvider: "" as string,
  customEndpointMode: "cloud" as CustomEndpointMode,
  /** 当前编辑的档案 id；undefined = 新建草稿。 */
  editingProfileId: undefined as string | undefined,
  /** 编辑中档案的推理偏好（无 UI，保存时透传）。 */
  editingReasoning: undefined as ReasoningPreference | undefined,
  /** 全部已保存档案 + 默认档案 id（档案列表渲染用）。 */
  profiles: [] as SavedProfileLite[],
  defaultProfileId: undefined as string | undefined,
};
