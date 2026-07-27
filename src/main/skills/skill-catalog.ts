// Skill 清單生成 —— 把 enabled skill 拼成注入 system prompt 的清單段。
// 純函數，不碰 electron/registry。

import type { SkillEntry } from "./types";

/**
 * 歧義識別策略。
 * 不"製造"歧義，而是"識別"用戶需求中天然存在的多解讀空間。
 * 用戶說了模糊風格詞（美觀/好看/專業）但沒給具體要求 → 彈卡片讓用戶選。
 * 用戶說了"你自己決定" → 不彈，直接用默認樣式。
 * 用戶給了明確細節 → 不彈，直接做。
 */
const AMBIGUITY_POLICY = [
  "",
  "## 歧義識別與處理策略",
  "",
  "### 何時彈卡片（ask_user_choice）",
  "當用戶**主動**提到風格/樣式相關詞（「美觀」「好看」「專業」「漂亮」「彩色」「規整」等）",
  "且**沒有給出具體要求**時，說明需求存在多解讀空間。此時應調用 ask_user_choice 讓用戶選擇具體方向，再按選擇執行。",
  "",
  "示例：",
  "- 「做個美觀的 Excel」→ 彈卡片（美觀可以是簡潔商務/彩色展示/財務報表等多種解讀）",
  "- 「弄得專業一點」→ 彈卡片（專業可以有多種風格）",
  "- 「做個漂亮點的報告」→ 彈卡片（漂亮可以有多種解讀）",
  "",
  "### 何時不彈卡片",
  "- 用戶說「你自己決定」「看著辦」→ 用戶已授權，直接用默認樣式，不要詢問",
  "- 用戶沒提任何樣式詞（「做個表」「導出 Excel」）→ 用默認樣式直接做",
  "- 用戶給了明確細節（「深藍表頭白色字」「凍結首行」「加邊框」）→ 直接按要求做",
  "- 用戶要求的是功能而非樣式（「加公式」「編輯已有文件」）→ 按功能需求執行",
  "",
  "### 工具選擇",
  "- 簡單表格 / 數據整理 → 直接用 write_excel（已內置美觀樣式），不要走 invoke_skill(xlsx)",
  "- 簡單文檔 / 報告 / 總結 → 直接用 write_word（已內置美觀樣式），不要走 invoke_skill(docx)",
  "- 用戶通過 ask_user_choice 選擇了風格 → 用對應 write_* 工具的 style 參數直接生成，不要走 skill 手寫 XML",
  "- write_excel 支持 5 種主題：default / dark / colorful / simple-business / financial",
  "- write_word 支持 5 種主題：default / academic / clean / elegant / formal",
  "- 用戶給了自定義顏色要求（如「粉色表頭」「深灰背景」）→ 用 write_excel 的 colors 參數傳 ARGB hex 值，你負責把顏色名翻譯成 hex",
  "- 只有用戶明確要求「公式」「財務格式標準」「條件格式」「編輯已有 xlsx」「頁眉頁腳/目錄/圖片」等具體高級需求時，才考慮 invoke_skill",
].join("\n");

/**
 * 生成注入 system prompt 的 skill 清單段（拼在人格層之後）。
 * 只含 enabled skill。返回空串表示無可用 skill（調用方據此跳過拼接）。
 */
export function buildSkillCatalog(skills: SkillEntry[]): string {
  const enabled = skills.filter(s => s.enabled);
  if (enabled.length === 0) return "";
  const lines = enabled.map(s => {
    const toolsTag = s.tools && s.tools.length > 0 ? ` [tools: ${s.tools.join(", ")}]` : "";
    return `- ${s.id}: ${s.description}${toolsTag}`;
  });
  return [
    "## 可用 Skill",
    "當某 skill 適用於當前任務時，先調用 invoke_skill(skill_id) 取詳細指令，再按指令用工具執行。",
    "",
    ...lines,
  ].join("\n") + AMBIGUITY_POLICY;
}
