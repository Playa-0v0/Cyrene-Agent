// Skill 系統 —— 類型定義。
// id 永遠 = 目錄名（kebab-case），是唯一對外標識；name 僅展示，不參與匹配。

/** 一個 skill 的完整內存表示。 */
export interface SkillEntry {
  id: string;            // = 目錄名，kebab-case，唯一對外標識
  name: string;          // frontmatter.name，僅展示，不參與匹配
  description: string;   // 注入 prompt 清單用
  tools?: string[];      // 關聯的 tool id
  version?: string;      // 語義版本，純展示
  dirPath: string;       // skill 目錄絕對路徑
  bodyPath: string;      // SKILL.md 絕對路徑
  references: string[];  // references/ 下文件名清單（不含內容）
  enabled: boolean;      // 運行時狀態，持久化到 settings.json
  source: "builtin" | "user";  // 來源
}

/** frontmatter 解析結果。 */
export interface ParsedSkill {
  name: string;
  description: string;
  tools?: string[];
  version?: string;
  body: string;  // SKILL.md 正文（frontmatter 之後）
}
