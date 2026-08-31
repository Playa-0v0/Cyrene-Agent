// Skill /命令解析 —— 纯函数，不依赖 registry。
// 调用方传已知 skill id 列表，只匹配列表内的命令；未知 /命令放行给其他处理。

/** parseSlashCommand 结果。hit=true 表示命中一个已知 skill /命令。 */
export interface SlashParseResult {
  hit: boolean;
  skillId?: string;
}

/**
 * 解析用户输入是否为 /skill-id 命令（且 skill 在已知列表内）。
 * 纯函数。id 必须是 kebab-case（小写字母/数字/短横线）。
 * 未命中语法、或不在 knownSkillIds 列表 → hit:false（放行，不误吞 /help 等其他命令）。
 * skill 是否存在/启用由调用方查 skillRegistry 决定。
 */
export function parseSlashCommand(text: string, knownSkillIds: string[]): SlashParseResult {
  const m = text.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/);
  if (!m) return { hit: false };
  const id = m[1];
  if (!knownSkillIds.includes(id)) return { hit: false };
  return { hit: true, skillId: id };
}
