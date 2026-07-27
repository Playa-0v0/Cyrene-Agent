// Skill 掃描器 —— frontmatter 解析 + 目錄掃描。
// 純函數模塊：parseSkillFrontmatter / scanSkills 不依賴 electron，便於單測。
// electron 相關（app.getPath）由調用方 initSkills 注入路徑。

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { ParsedSkill, SkillEntry } from "./types";

/** gray-matter 解析結果的最小結構（不依賴其類型導出，規避 export = 的類型訪問問題）。 */
interface MatterResult {
  data: Record<string, unknown>;
  content: string;
}

/**
 * 解析 SKILL.md 文本：frontmatter（name/description/tools?/version?/autoInject?）+ 正文。
 * 純函數，不碰 fs/electron。
 * 返回 null 表示不合規（缺 name/description、tools 非 array、或無 frontmatter）。
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
  return {
    name: d.name,
    description: d.description,
    tools: Array.isArray(d.tools) ? d.tools.map(String) : undefined,
    version: d.version !== undefined ? String(d.version) : undefined,
    body: parsed.content.trim(),
  };
}

/**
 * 掃描單個 skill 根目錄，返回合規的 SkillEntry 列表。
 * 純函數：只依賴傳入的目錄路徑，不碰 electron。
 *
 * @param dir skill 根目錄（其下每個子目錄是一個 skill）
 * @param source 這批 skill 的來源標記（builtin/user）
 *
 * 不合規的 skill（無 SKILL.md、frontmatter 解析失敗）跳過並 warn，不拋錯。
 * enabled 統一默認 true，由 initSkills 合併 settings.json 覆蓋。
 * 跨源覆蓋（user 覆蓋 builtin）由 initSkills 合併時處理，不在本函數。
 */
export function scanSkills(dir: string, source: "builtin" | "user"): SkillEntry[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];  // 目錄不存在或無權限
  }
  const result: SkillEntry[] = [];
  for (const id of entries) {
    const skillDir = path.join(dir, id);
    const mdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(mdPath)) {
      console.warn("[Skills] 跳過無 SKILL.md 的目錄:", skillDir);
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
      console.warn("[Skills] 跳過不合規 SKILL.md（缺 name/description 或 frontmatter 解析失敗）:", mdPath);
      continue;
    }
    if (parsed.name !== id) {
      console.warn(`[Skills] name(${parsed.name}) ≠ 目錄名(${id})，id 用目錄名`);
    }
    // 列 references 文件名清單（不含內容）
    let references: string[] = [];
    const refDir = path.join(skillDir, "references");
    try {
      if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
        references = fs.readdirSync(refDir).filter(f => fs.statSync(path.join(refDir, f)).isFile());
      }
    } catch {
      references = [];
    }
    result.push({
      id,
      name: parsed.name,
      description: parsed.description,
      tools: parsed.tools,
      version: parsed.version,
      dirPath: skillDir,
      bodyPath: mdPath,
      references,
      enabled: true,
      source,
    });
  }
  return result;
}
