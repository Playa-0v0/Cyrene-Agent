// 通用保存状态条：7 个面板的 save-status DOM 文本/类名更新
// 从 settings.ts 抽离。
// 依赖：shared/shell.ts（全局壳 save-status）+ appearance/general 面板内 save-status DOM。

import { saveStatus, cyreneSaveStatus, preferencesSaveStatus, runtimeSaveStatus } from "./shell";
import { appearanceSaveStatus } from "../appearance/dom";
import { generalSaveStatus } from "../general/dom";

export function setSaveStatus(text: string, cls?: string): void {
  saveStatus.textContent = text;
  saveStatus.className = "save-status";
  if (cls) saveStatus.classList.add(cls);
}

export function setCyreneSaveStatus(text: string, cls?: string): void {
  cyreneSaveStatus.textContent = text;
  cyreneSaveStatus.className = "save-status";
  if (cls) cyreneSaveStatus.classList.add(cls);
}

export function setPreferencesSaveStatus(text: string, cls?: string): void {
  preferencesSaveStatus.textContent = text;
  preferencesSaveStatus.className = "save-status";
  if (cls) preferencesSaveStatus.classList.add(cls);
}

export function setAppearanceSaveStatus(text: string, cls?: string): void {
  appearanceSaveStatus.textContent = text;
  appearanceSaveStatus.className = "save-status";
  if (cls) appearanceSaveStatus.classList.add(cls);
}

export function setGeneralSaveStatus(text: string, cls?: string): void {
  generalSaveStatus.textContent = text;
  generalSaveStatus.className = "save-status";
  if (cls) generalSaveStatus.classList.add(cls);
}

export function setRuntimeSaveStatus(text: string, cls?: string): void {
  runtimeSaveStatus.textContent = text;
  runtimeSaveStatus.className = "save-status";
  if (cls) runtimeSaveStatus.classList.add(cls);
}
