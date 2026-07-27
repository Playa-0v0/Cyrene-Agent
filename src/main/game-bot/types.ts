// game-bot 類型定義 —— 腳本原語 + GameRecipe。
// 純類型，無副作用。id 永遠 = 腳本文件名（去 .yaml），name 僅展示。

// ── 原語 ──────────────────────────────────────────────────
// 每個原語一個 interface；Step 是聯合類型。branch.then/else 遞歸為 Step[]。

export interface StepLaunch { type: "launch"; exe: string; }
export interface StepYaaglStart { type: "yaagl_start"; }
export interface StepWait { type: "wait"; ms: number; }
export interface StepKey { type: "key"; combo: string; }  // "F4" / "Alt+F4"
export interface StepClick {
  type: "click";
  target: "center" | { x: number; y: number } | { ratioX: number; ratioY: number };
}

export interface StepVlmClick {
  type: "vlm_click";
  ref: string;          // 參考小圖名（紅框裁出）
  target?: string;      // 給 VLM 的補充描述（可選）
  repeat?: number;      // 連點次數，默認 1
  interval?: number;    // 連點間隔 ms，默認 1000
  retry?: number;       // 定位失敗重試次數，默認 2
  settle?: number;      // 截圖前等待 ms，覆蓋引擎默認
}

export interface StepVlmSelect {
  type: "vlm_select";
  desc: string;         // 語義描述，如"支援列表第一個"（無參考圖）
  retry?: number;       // 默認 2
  settle?: number;
}

export interface StepVlmCheck {
  type: "vlm_check";
  id: string;           // 結果綁定到變量 ${id}（布爾），供 branch.if 用
  ask: string;
  ref?: string;         // 可選狀態參考圖
  settle?: number;
}

export interface StepVlmCompare {
  type: "vlm_compare";
  id: string;           // 結果綁定到變量 ${id}（匹配的 ref 索引或描述）
  ask: string;
  refs: string[];       // 多張參考圖
  settle?: number;
}

export interface StepBranch {
  type: "branch";
  if: string;           // 表達式，如 "${has_update}" / "${auto_battle_state == 'off'}"
  then: Step[];
  else?: Step[];
}

export type Step =
  | StepLaunch | StepYaaglStart | StepWait | StepKey | StepClick
  | StepVlmClick | StepVlmSelect | StepVlmCheck | StepVlmCompare
  | StepBranch;

export interface GameRecipe {
  name: string;
  exe: string;          // 可含 ${exe_path}
  model?: string;       // 可含 ${vlm_config}；留空則用全局 VLM 配置
  steps: Step[];
}
