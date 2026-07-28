// Skill 清单生成 —— 把 enabled skill 拼成注入 system prompt 的清单段。
// 纯函数，不碰 electron/registry。

import type { SkillEntry } from "./types";

/**
 * 歧义识别策略。
 * 不"制造"歧义，而是"识别"用户需求中天然存在的多解读空间。
 * 用户说了模糊风格词（美观/好看/专业）但没给具体要求 → 弹卡片让用户选。
 * 用户说了"你自己决定" → 不弹，直接用默认样式。
 * 用户给了明确细节 → 不弹，直接做。
 */
const AMBIGUITY_POLICY = [
  "",
  "## 歧义识别与处理策略",
  "",
  "### 何时弹卡片（ask_user_choice）",
  "当用户**主动**提到风格/样式相关词（「美观」「好看」「专业」「漂亮」「彩色」「规整」等）",
  "且**没有给出具体要求**时，说明需求存在多解读空间。此时应调用 ask_user_choice 让用户选择具体方向，再按选择执行。",
  "",
  "示例：",
  "- 「做个美观的 Excel」→ 弹卡片（美观可以是简洁商务/彩色展示/财务报表等多种解读）",
  "- 「弄得专业一点」→ 弹卡片（专业可以有多种风格）",
  "- 「做个漂亮点的报告」→ 弹卡片（漂亮可以有多种解读）",
  "",
  "### 何时不弹卡片",
  "- 用户说「你自己决定」「看着办」→ 用户已授权，直接用默认样式，不要询问",
  "- 用户没提任何样式词（「做个表」「导出 Excel」）→ 用默认样式直接做",
  "- 用户给了明确细节（「深蓝表头白色字」「冻结首行」「加边框」）→ 直接按要求做",
  "- 用户要求的是功能而非样式（「加公式」「编辑已有文件」）→ 按功能需求执行",
  "",
  "### 工具选择",
  "- 简单表格 / 数据整理 → 直接用 write_excel（已内置美观样式），不要走 invoke_skill(xlsx)",
  "- 简单文档 / 报告 / 总结 → 直接用 write_word（已内置美观样式），不要走 invoke_skill(docx)",
  "- 用户通过 ask_user_choice 选择了风格 → 用对应 write_* 工具的 style 参数直接生成，不要走 skill 手写 XML",
  "- write_excel 支持 5 种主题：default / dark / colorful / simple-business / financial",
  "- write_word 支持 5 种主题：default / academic / clean / elegant / formal",
  "- 用户给了自定义颜色要求（如「粉色表头」「深灰背景」）→ 用 write_excel 的 colors 参数传 ARGB hex 值，你负责把颜色名翻译成 hex",
  "- 只有用户明确要求「公式」「财务格式标准」「条件格式」「编辑已有 xlsx」「页眉页脚/目录/图片」等具体高级需求时，才考虑 invoke_skill",
].join("\n");

/**
 * 生成注入 system prompt 的 skill 清单段（拼在人格层之后）。
 * 只含 enabled skill。返回空串表示无可用 skill（调用方据此跳过拼接）。
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
  return [
    "## 可用 Skill",
    "当未自动注入的 skill 适用于当前任务时，先调用 invoke_skill(skill_id) 取详细指令；标记为自动注入的 skill 已在后文提供完整规则，无需再次调用 invoke_skill。",
    "",
    ...lines,
  ].join("\n") + AMBIGUITY_POLICY;
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
 * Soul 阶段没有工具能力，只注入 Skill 明确声明的回复策略小节。
 * 其余工具流程仍只属于 TOOL_PHASE，避免模型把工具协议输出成聊天文本。
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
