// Skill 系统启动入口 + 对外 API。
// 唯一碰 electron 的模块（app.getPath）；scanSkills/registry/tools 都是纯逻辑或单例。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { scanSkills } from "./skill-scanner";
import { skillRegistry } from "./skill-registry";
import { registerSkillTools } from "./skill-tools";
import type { SkillEntry } from "./types";

const LOG_PREFIX = "[Skills]";

/** skill enabled 状态持久化文件（userData/skills-enabled.json）。 */
function enabledStatePath(): string {
  return path.join(app.getPath("userData"), "skills-enabled.json");
}

/** 读取持久化的 enabled 状态（id → bool）。 */
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
 * 启动入口：扫描双源 skills → 灌入 registry（user 目录级覆盖 builtin + 合并 enabled 状态）→ 注册 meta-tool。
 * 必须在 app.whenReady 之后调用（依赖 app.getPath）。
 */
export function initSkills(): void {
  const builtinDir = path.join(app.getAppPath(), "skills");
  const userDir = path.join(app.getPath("userData"), "skills");

  const builtin = scanSkills(builtinDir, "builtin");
  const user = scanSkills(userDir, "user");

  // 合并：按 id，user 覆盖 builtin（目录级整体覆盖，见 spec 4.1）
  const map = new Map<string, SkillEntry>();
  for (const s of builtin) map.set(s.id, s);
  for (const s of user) map.set(s.id, s);

  // 合并 enabled 状态（settings.json 持久化的覆盖默认 true）
  const saved = loadEnabledState();
  for (const s of map.values()) {
    if (s.id in saved) s.enabled = saved[s.id];
    skillRegistry.register(s);
  }

  registerSkillTools();
  console.log(LOG_PREFIX, `已加载 ${map.size} 个 skill：`, Array.from(map.keys()).join(", ") || "(无)");
}

/** 持久化某 skill 的 enabled 状态。 */
export function setSkillEnabled(id: string, enabled: boolean): void {
  skillRegistry.setEnabled(id, enabled);
  try {
    const saved = loadEnabledState();
    saved[id] = enabled;
    fs.mkdirSync(path.dirname(enabledStatePath()), { recursive: true });
    fs.writeFileSync(enabledStatePath(), JSON.stringify(saved, null, 2), "utf8");
  } catch (err) {
    console.warn(LOG_PREFIX, "持久化 enabled 失败:", err);
  }
}

/** 返回所有 skill 的元数据（给 UI 用）。 */
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
export { buildAutoInjectedSkillContext, buildAutoInjectedSoulContext, buildSkillCatalog } from "./skill-catalog";
export { parseSlashCommand } from "./skill-commands";
