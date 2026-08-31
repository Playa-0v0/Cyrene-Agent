// Memory 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

import type { MemoryPanelPayload } from "../shared/types";

export const memoryState = {
  panelCache: null as MemoryPanelPayload | null,
  l0Editing: false as boolean,
  l1Editing: false as boolean,
  l0Snapshot: null as Record<string, string> | null,
  l1Snapshot: null as Record<string, string> | null,
};
