// Skill 系統啟動入口 + 對外 API。
// 唯一碰 electron 的模塊（app.getPath）；scanSkills/registry/tools 都是純邏輯或單例。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { scanSkills } from "./skill-scanner";
import { skillRegistry } from "./skill-registry";
import { registerSkillTools } from "./skill-tools";
import type { SkillEntry } from "./types";

const LOG_PREFIX = "[Skills]";

/** skill enabled 狀態持久化文件（userData/skills-enabled.json）。 */
function enabledStatePath(): string {
  return path.join(app.getPath("userData"), "skills-enabled.json");
}

/** 讀取持久化的 enabled 狀態（id → bool）。 */
function loadEnabledState(): Record<string, boolean> {
  try {
    const p = enabledStatePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * 啟動入口：掃描雙源 skills → 灌入 registry（user 目錄級覆蓋 builtin + 合併 enabled 狀態）→ 註冊 meta-tool。
 * 必須在 app.whenReady 之後調用（依賴 app.getPath）。
 */
export function initSkills(): void {
  const builtinDir = path.join(app.getAppPath(), "skills");
  const userDir = path.join(app.getPath("userData"), "skills");

  const builtin = scanSkills(builtinDir, "builtin");
  const user = scanSkills(userDir, "user");

  // 合併：按 id，user 覆蓋 builtin（目錄級整體覆蓋，見 spec 4.1）
  const map = new Map<string, SkillEntry>();
  for (const s of builtin) map.set(s.id, s);
  for (const s of user) map.set(s.id, s);

  // 合併 enabled 狀態（settings.json 持久化的覆蓋默認 true）
  const saved = loadEnabledState();
  for (const s of map.values()) {
    if (s.id in saved) s.enabled = saved[s.id];
    skillRegistry.register(s);
  }

  registerSkillTools();
  console.log(LOG_PREFIX, `已加載 ${map.size} 個 skill：`, Array.from(map.keys()).join(", ") || "(無)");
}

/** 持久化某 skill 的 enabled 狀態。 */
export function setSkillEnabled(id: string, enabled: boolean): void {
  skillRegistry.setEnabled(id, enabled);
  try {
    const saved = loadEnabledState();
    saved[id] = enabled;
    fs.mkdirSync(path.dirname(enabledStatePath()), { recursive: true });
    fs.writeFileSync(enabledStatePath(), JSON.stringify(saved, null, 2), "utf8");
  } catch (err) {
    console.warn(LOG_PREFIX, "持久化 enabled 失敗:", err);
  }
}

/** 返回所有 skill 的元數據（給 UI 用）。 */
export function listSkillsForUi() {
  return skillRegistry.getAll().map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tools: s.tools ?? [],
    enabled: s.enabled,
    source: s.source,
    version: s.version,
    references: s.references,
  }));
}

export { skillRegistry } from "./skill-registry";
export { buildSkillCatalog } from "./skill-catalog";
export { parseSlashCommand } from "./skill-commands";
