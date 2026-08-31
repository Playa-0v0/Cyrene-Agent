// Skill 扫描器 —— frontmatter 解析 + 目录扫描。
// 纯函数模块：parseSkillFrontmatter / scanSkills 不依赖 electron，便于单测。
// electron 相关（app.getPath）由调用方 initSkills 注入路径。

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { ParsedSkill, SkillEntry, SkillManifest, SkillMode } from "./types";
import { logger } from "../../shared/logger";
import { LogTag } from "../../shared/logger-tags";

function readManifest(skillDir: string, id: string): SkillManifest | undefined {
  const manifestPath = path.join(skillDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<SkillManifest>;
    if (value.id !== id || typeof value.version !== "string" || typeof value.defaultEnabled !== "boolean"
      || typeof value.entry !== "string" || !Array.isArray(value.dependencies)) return undefined;
    return { ...value, dependencies: value.dependencies.map(String) } as SkillManifest;
  } catch {
    return undefined;
  }
}

/** gray-matter 解析结果的最小结构（不依赖其类型导出，规避 export = 的类型访问问题）。 */
interface MatterResult {
  data: Record<string, unknown>;
  content: string;
}

const VALID_SKILL_MODES = new Set<SkillMode>(["work", "code", "learn"]);

function normalizeSkillModes(raw: unknown): SkillMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const modes = raw
    .map((m) => (typeof m === "string" ? m.trim().toLowerCase() : undefined))
    .filter((m): m is SkillMode => !!m && VALID_SKILL_MODES.has(m as SkillMode));
  return modes.length > 0 ? modes : undefined;
}

/**
 * 解析 SKILL.md 文本：frontmatter（name/description/tools?/version?/effectKind?/modes?）+ 正文。
 * 纯函数，不碰 fs/electron。
 * 返回 null 表示不合规（缺 name/description、tools 非 array、或无 frontmatter）。
 */
export function parseSkillFrontmatter(content: string): ParsedSkill | null {
  let parsed: MatterResult;
  try {
    parsed = matter(content) as unknown as MatterResult;
  } catch {
    return null;
  }
  const d = parsed.data ?? {};
  if (typeof d.name !== "string" || !d.name) return null;
  if (typeof d.description !== "string" || !d.description) return null;
  if (d.tools !== undefined && !Array.isArray(d.tools)) return null;
  const VALID_EFFECT_KINDS = new Set(["read", "mutation", "verification", "external_side_effect"]);
  const effectKind = typeof d.effectKind === "string" && VALID_EFFECT_KINDS.has(d.effectKind)
    ? d.effectKind as import("../orchestrator/tool-registry").ToolEffectKind
    : undefined;
  const hiddenFromUi = d.hiddenFromUi === true || d.hiddenFromUi === "true";
  return {
    name: d.name,
    description: d.description,
    tools: Array.isArray(d.tools) ? d.tools.map(String) : undefined,
    version: d.version !== undefined ? String(d.version) : undefined,
    effectKind,
    modes: normalizeSkillModes(d.modes),
    hiddenFromUi,
    body: parsed.content.trim(),
  };
}

/**
 * 扫描单个 skill 根目录，返回合规的 SkillEntry 列表。
 * 纯函数：只依赖传入的目录路径，不碰 electron。
 *
 * @param dir skill 根目录（其下每个子目录是一个 skill）
 * @param source 这批 skill 的来源标记（builtin/user）
 *
 * 不合规的 skill（无 SKILL.md、frontmatter 解析失败）跳过并 warn，不抛错。
 * enabled 统一默认 true，由 initSkills 合并 settings.json 覆盖。
 * 跨源覆盖（user 覆盖 builtin）由 initSkills 合并时处理，不在本函数。
 */
export function scanSkills(dir: string, source: "builtin" | "user"): SkillEntry[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];  // 目录不存在或无权限
  }
  const result: SkillEntry[] = [];
  for (const id of entries) {
    const skillDir = path.join(dir, id);
    const mdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(mdPath)) {
      console.warn("[Skills] 跳过无 SKILL.md 的目录:", skillDir);
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(content);
    if (!parsed) {
      console.warn("[Skills] 跳过不合规 SKILL.md（缺 name/description 或 frontmatter 解析失败）:", mdPath);
      continue;
    }
    if (parsed.name !== id) {
      logger.warn(LogTag.Skills, `name(${parsed.name}) != dir(${id}), using dir as id`);
    }
    // 列 references 文件名清单（不含内容）
    let references: string[] = [];
    const refDir = path.join(skillDir, "references");
    try {
      if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
        references = fs.readdirSync(refDir).filter(f => fs.statSync(path.join(refDir, f)).isFile());
      }
    } catch {
      references = [];
    }
    const manifest = readManifest(skillDir, id);
    result.push({
      id,
      name: parsed.name,
      description: parsed.description,
      tools: parsed.tools ?? manifest?.dependencies,
      version: parsed.version ?? manifest?.version,
      dirPath: skillDir,
      bodyPath: mdPath,
      references,
      enabled: manifest?.defaultEnabled ?? true,
      source,
      manifest,
      effectKind: parsed.effectKind,
      modes: parsed.modes,
      hiddenFromUi: parsed.hiddenFromUi,
    });
  }
  return result;
}
