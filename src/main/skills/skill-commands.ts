// Skill /命令解析 —— 純函數，不依賴 registry。
// 調用方傳已知 skill id 列表，只匹配列表內的命令；未知 /命令放行給其他處理。

/** parseSlashCommand 結果。hit=true 表示命中一個已知 skill /命令。 */
export interface SlashParseResult {
  hit: boolean;
  skillId?: string;
}

/**
 * 解析用戶輸入是否為 /skill-id 命令（且 skill 在已知列表內）。
 * 純函數。id 必須是 kebab-case（小寫字母/數字/短橫線）。
 * 未命中語法、或不在 knownSkillIds 列表 → hit:false（放行，不誤吞 /help 等其他命令）。
 * skill 是否存在/啟用由調用方查 skillRegistry 決定。
 */
export function parseSlashCommand(text: string, knownSkillIds: string[]): SlashParseResult {
  const m = text.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/);
  if (!m) return { hit: false };
  const id = m[1];
  if (!knownSkillIds.includes(id)) return { hit: false };
  return { hit: true, skillId: id };
}
