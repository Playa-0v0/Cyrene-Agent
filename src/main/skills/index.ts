// Skill 系统启动入口 + 对外 API。
// 唯一碰 electron 的模块（app.getPath）；scanSkills/registry/tools 都是纯逻辑或单例。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { scanSkills } from "./skill-scanner";
import { skillRegistry } from "./skill-registry";
import { registerSkillTools } from "./skill-tools";
import type { SkillEntry } from "./types";
import { logger, LogTag } from "../logger";
import { getExternalContentPaths, resolveSkillScanSources, resolveSkillsSnapshotArchivePath } from "../external-content-paths";
import { installSkillsSnapshot } from "./snapshot-install";

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
 * 启动入口：首启把第三方 skills 快照解压到 user 区（哨兵保证只装一次），
 * 再扫描双源 skills → 灌入 registry（user 目录级覆盖 builtin + 合并 enabled 状态）→ 注册 meta-tool。
 * 必须在 app.whenReady 之后调用（依赖 app.getPath）。
 */
export async function initSkills(): Promise<void> {
  const paths = getExternalContentPaths();

  // 快照安装必须在扫描之前完成，否则首启扫不到归档里的第三方 skill。
  const archivePath = resolveSkillsSnapshotArchivePath(paths);
  const userSkillsDir = paths.userSkillDirectories[0];
  await installSkillsSnapshot({ archivePath, userSkillsDir });

  const sources = resolveSkillScanSources(paths);

  // 合并：扫描源按低到高优先级排列，user 覆盖 builtin。
  const map = new Map<string, SkillEntry>();
  for (const source of sources) {
    for (const skill of scanSkills(source.directory, source.source)) map.set(skill.id, skill);
  }

  // 合并 enabled 状态（settings.json 持久化的覆盖默认 true）
  const saved = loadEnabledState();
  for (const s of map.values()) {
    if (s.id in saved) s.enabled = saved[s.id];
    skillRegistry.register(s);
  }

  registerSkillTools();
  logger.info(LogTag.Skills, "scan roots:", sources.map((source) => `${source.source}:${source.directory}`).join(" | "));
  logger.info(LogTag.Skills, `loaded ${map.size} skills:`, Array.from(map.keys()).join(", ") || "(none)");
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

/** 返回所有 skill 的元数据（给 UI 用）。hiddenFromUi 的技能不暴露。 */
export function listSkillsForUi() {
  return skillRegistry
    .getAll()
    .filter((s) => !s.hiddenFromUi)
    .map(s => ({
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

/**
 * 重新扫描 user skills 目录并更新 registry。
 * 用于用户安装/删除 skill 后，无需重启应用即可刷新 UI。
 * 返回扫描后 registry 中 skill 总数。
 */
export function rescanSkills(): number {
  const sources = resolveSkillScanSources(getExternalContentPaths());

  const map = new Map<string, SkillEntry>();
  for (const source of sources) {
    for (const skill of scanSkills(source.directory, source.source)) map.set(skill.id, skill);
  }

  const saved = loadEnabledState();
  // 清理 registry 中已不存在的 skill，避免删除后仍残留
  for (const id of skillRegistry.getAll().map((s) => s.id)) {
    if (!map.has(id)) skillRegistry.unregister?.(id);
  }
  for (const s of map.values()) {
    if (s.id in saved) s.enabled = saved[s.id];
    skillRegistry.register(s);
  }

  logger.info(LogTag.Skills, `rescanned ${map.size} skills:`, Array.from(map.keys()).join(", ") || "(none)");
  return map.size;
}

export { skillRegistry } from "./skill-registry";
export { buildAutoInjectedSkillContext, buildAutoInjectedSoulContext, buildSkillCatalog } from "./skill-catalog";
export { parseSlashCommand } from "./skill-commands";
