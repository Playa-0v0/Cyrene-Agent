// Skill 系统 —— 类型定义。
// id 永远 = 目录名（kebab-case），是唯一对外标识；name 仅展示，不参与匹配。

/** 一个 skill 的完整内存表示。 */
export interface SkillEntry {
  id: string;            // = 目录名，kebab-case，唯一对外标识
  name: string;          // frontmatter.name，仅展示，不参与匹配
  description: string;   // 注入 prompt 清单用
  tools?: string[];      // 关联的 tool id
  version?: string;      // 语义版本，纯展示
  dirPath: string;       // skill 目录绝对路径
  bodyPath: string;      // SKILL.md 绝对路径
  references: string[];  // references/ 下文件名清单（不含内容）
  enabled: boolean;      // 运行时状态，持久化到 settings.json
  source: "builtin" | "user";  // 来源
  manifest?: SkillManifest;
}

export interface SkillManifest {
  id: string;
  version: string;
  defaultEnabled: boolean;
  entry: string;
  dependencies: string[];
  autoInject?: boolean;
  autoPlayPolicy?: string;
  /** Task Router 快捷路径命中时使用的默认执行模式 */
  defaultExecutionMode?: "direct" | "plan";
}

/** frontmatter 解析结果。 */
export interface ParsedSkill {
  name: string;
  description: string;
  tools?: string[];
  version?: string;
  body: string;  // SKILL.md 正文（frontmatter 之后）
}
