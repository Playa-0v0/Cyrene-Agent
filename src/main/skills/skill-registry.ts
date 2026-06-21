// Skill 注册表 —— 镜像 ToolRegistry 的 Map + 单例模式。
// 启动时由 initSkills 灌入扫描结果；getBody/getReference 懒加载 + 缓存。

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
   * 懒加载 SKILL.md 正文（去掉 frontmatter）+ 缓存。
   * 运行时只读不改，缓存安全（见 spec 5.4：编辑已加载 skill 正文需重启）。
   * 返回 null 表示 skill 不存在或读取失败。
   */
  getBody(id: string): string | null {
    const cached = this.bodyCache.get(id);
    if (cached !== undefined) return cached;
    const s = this.skills.get(id);
    if (!s) return null;
    try {
      const raw = fs.readFileSync(s.bodyPath, "utf8");
      // 复用 scanner 的 gray-matter 解析剥离 frontmatter，避免与 scanner 正则分叉（BOM/多行 ---）
      const parsed = parseSkillFrontmatter(raw);
      const body = parsed ? parsed.body : raw.trim();
      this.bodyCache.set(id, body);
      return body;
    } catch {
      return null;
    }
  }

  /**
   * 读 references 附件。
   * 路径穿越防护：ref 必须命中扫描阶段缓存的 references 清单，且不含路径分隔符/..，
   * 否则拒绝（返回 null）。不直接拿 ref 拼路径。
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

// 全局单例
export const skillRegistry = new SkillRegistry();
