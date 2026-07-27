// Skill 註冊表 —— 鏡像 ToolRegistry 的 Map + 單例模式。
// 啟動時由 initSkills 灌入掃描結果；getBody/getReference 懶加載 + 緩存。

import * as fs from "fs";
import * as path from "path";
import type { SkillEntry } from "./types";
import { parseSkillFrontmatter } from "./skill-scanner";

export class SkillRegistry {
  private skills = new Map<string, SkillEntry>();
  private bodyCache = new Map<string, string>();

  register(skill: SkillEntry): void {
    this.skills.set(skill.id, skill);
  }

  getEnabled(): SkillEntry[] {
    return Array.from(this.skills.values()).filter(s => s.enabled);
  }

  getAll(): SkillEntry[] {
    return Array.from(this.skills.values());
  }

  getById(id: string): SkillEntry | undefined {
    return this.skills.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const s = this.skills.get(id);
    if (s) s.enabled = enabled;
  }

  /**
   * 懶加載 SKILL.md 正文（去掉 frontmatter）+ 緩存。
   * 運行時只讀不改，緩存安全（見 spec 5.4：編輯已加載 skill 正文需重啟）。
   * 返回 null 表示 skill 不存在或讀取失敗。
   */
  getBody(id: string): string | null {
    const cached = this.bodyCache.get(id);
    if (cached !== undefined) return cached;
    const s = this.skills.get(id);
    if (!s) return null;
    try {
      const raw = fs.readFileSync(s.bodyPath, "utf8");
      // 複用 scanner 的 gray-matter 解析剝離 frontmatter，避免與 scanner 正則分叉（BOM/多行 ---）
      const parsed = parseSkillFrontmatter(raw);
      const body = parsed ? parsed.body : raw.trim();
      this.bodyCache.set(id, body);
      return body;
    } catch {
      return null;
    }
  }

  /**
   * 讀 references 附件。
   * 路徑穿越防護：ref 必須命中掃描階段緩存的 references 清單，且不含路徑分隔符/..，
   * 否則拒絕（返回 null）。不直接拿 ref 拼路徑。
   */
  getReference(id: string, ref: string): string | null {
    const s = this.skills.get(id);
    if (!s) return null;
    if (!s.references.includes(ref)) return null;
    if (ref.includes("/") || ref.includes("\\") || ref.includes("..")) return null;
    const refPath = path.join(s.dirPath, "references", ref);
    try {
      return fs.readFileSync(refPath, "utf8");
    } catch {
      return null;
    }
  }
}

// 全局單例
export const skillRegistry = new SkillRegistry();
