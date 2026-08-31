import { parseSlashCommand, skillRegistry } from "./index";
import type { SkillMode, SkillModeOverrides } from "./types";

/**
 * 解析最近一条 user 消息中的 /命令。
 * 命中且 skill 已启用可用 → 注入该 skill 的 body。
 * 命中但 skill 不存在/未启用/当前模式不允许 → 改写该 user 消息为提示，返回 ""。
 * 未命中 → 返回 ""（放行，不误吞其他 /命令）。
 * （正文注入 system，user message 原样，不污染 memory，见 spec 6.3）。
 *
 * 三模适配层：提供 mode + overrides 时，只会激活当前会话模式允许的 skill。
 */
export function resolveSlashActivation<T extends { role: string; content: string }>(
  messages: T[],
  mode?: SkillMode,
  overrides?: SkillModeOverrides,
): string {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return "";
  const lastUser = messages[lastUserIdx];
  if (typeof lastUser.content !== "string") return "";
  const knownIds = skillRegistry.getAll().map(s => s.id);
  const parsed = parseSlashCommand(lastUser.content, knownIds);
  if (!parsed.hit || !parsed.skillId) return "";
  const skill = skillRegistry.getById(parsed.skillId);

  const isEnabledForMode = (s: typeof skill): boolean => {
    if (!s) return false;
    if (mode === undefined) return true;
    const override = overrides?.[s.id]?.[mode];
    if (override !== undefined) return override;
    return !s.modes || s.modes.includes(mode);
  };

  if (skill && skill.enabled && skillRegistry.isAvailable(parsed.skillId) && isEnabledForMode(skill)) {
    const body = skillRegistry.getBody(parsed.skillId);
    if (body !== null) {
      console.log("[Cyrene] /命令激活 skill:", parsed.skillId);
      return `\n\n---\n\n[已激活 skill: ${parsed.skillId}]\n${body}`;
    }
    return "";
  }
  // skill 不存在/未启用/当前模式不可用：替换该 user 消息为提示
  const available = skillRegistry.getEnabled().map(s => s.id).join(", ") || "(无)";
  messages[lastUserIdx] = { ...lastUser, content: `[系统提示：skill 未启用、不存在或当前模式不可用: ${parsed.skillId}。可用 skill: ${available}]` } as T;
  return "";
}
