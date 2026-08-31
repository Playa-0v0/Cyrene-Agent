// Skill 清单生成 —— 把 enabled skill 拼成注入 system prompt 的清单段。
// 纯函数，不碰 electron/registry。

import type { SkillEntry } from "./types";

/**
 * Skill 匹配判断流程（流程式清单头）。
 * 针对 Recall 不足（该调用没调用）的修复：陈述式清单让模型跳过匹配判断，
 * 流程式规则强制模型在选择基础工具前逐项做语义匹配。
 * 匹配标准是「Skill 能力是否适用于完成当前任务」（semantic routing），
 * 不是关键词重合（keyword routing 会把 Precision 搞坏）。
 */
const SKILL_SELECTION_HEADER = [
  "## Skill 选择",
  "以下 Skill 均为用户当前明确启用的能力。",
  "",
  "在选择基础工具或直接回复用户之前，必须先执行 Skill 匹配判断：",
  "",
  "1. 逐项检查下方 Skill 的 description。",
  "2. 判断该 Skill 描述的能力是否适用于完成当前用户任务。",
  "3. 如果一个或多个 Skill 适用，必须先调用 invoke_skill(skill_id) 加载对应完整规则，再继续任务。",
  "4. 不要仅因为你自己已经知道如何完成任务，就跳过适用的 Skill。",
  "5. 如果没有任何 Skill 适用，则正常使用基础工具或直接回复。",
  "",
  "Skill 清单：",
].join("\n");

/**
 * 生成注入 system prompt 的 skill 清单段（拼在人格层之后）。
 * 只含 enabled skill。返回空串表示无可用 skill（调用方据此跳过拼接）。
 * 职责边界：清单只负责「什么时候值得加载某 Skill」；
 * 真正执行时的边界情况（如 xlsx/docx 的歧义处理规则）由各自 SKILL.md 正文负责。
 */
export function buildSkillCatalog(skills: SkillEntry[]): string {
  const enabled = skills.filter(s => s.enabled);
  if (enabled.length === 0) return "";
  const lines = enabled.map(s => {
    const toolsTag = s.tools && s.tools.length > 0 ? ` [tools: ${s.tools.join(", ")}]` : "";
    const activationTag = s.manifest?.autoInject === true
      ? " [自动注入：无需再次调用 invoke_skill]"
      : "";
    return `- ${s.id}: ${s.description}${toolsTag}${activationTag}`;
  });
  return [SKILL_SELECTION_HEADER, ...lines].join("\n");
}

/**
 * 为显式声明 autoInject 的复合 Skill 注入完整规则。
 * 能力可用性已由 SkillRegistry.getEnabled() 过滤；读取失败时安全跳过。
 */
export function buildAutoInjectedSkillContext(
  skills: SkillEntry[],
  getBody: (id: string) => string | null,
): string {
  const blocks = skills
    .filter((skill) => skill.enabled && skill.manifest?.autoInject === true)
    .map((skill) => {
      const body = getBody(skill.id)?.trim();
      return body ? `### ${skill.id}\n${body}` : "";
    })
    .filter(Boolean);
  if (blocks.length === 0) return "";
  return [
    "## 自动激活 Skill 指令",
    "以下 Skill 已通过能力门控，当前对话必须直接遵循其完整规则，无需再次调用 invoke_skill。",
    "",
    ...blocks,
  ].join("\n");
}

/**
 * chat 模式没有工具能力，只注入 Skill 明确声明的回复策略小节。
 * 其余工具流程仍只属于带工具的 harness 循环，避免模型把工具协议输出成聊天文本。
 */
export function buildAutoInjectedSoulContext(
  skills: SkillEntry[],
  getBody: (id: string) => string | null,
): string {
  const blocks = skills
    .filter((skill) => skill.enabled && skill.manifest?.autoInject === true)
    .map((skill) => {
      const body = getBody(skill.id) ?? "";
      const match = body.match(/^## Soul 回复策略\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
      const section = match?.[1]?.trim();
      return section ? `### ${skill.id}\n${section}` : "";
    })
    .filter(Boolean);
  if (blocks.length === 0) return "";
  return [
    "## 自动激活 Skill 回复策略",
    "以下内容只约束自然语言回复；当前阶段没有工具能力，不得输出工具名、调用标记或工具协议。",
    "",
    ...blocks,
  ].join("\n");
}
