import type { ConversationMode } from "../../shared/chat-types";
import type { SkillEntry, SkillMode, SkillModeOverrides } from "../skills/types";
import type { ToolDefinition, ToolModeOverrides } from "./tool-registry";
import { filterToolsBySearchBackend, type SearchBackend } from "./search-backend-filter";

export interface RunCapabilities {
  mode: ConversationMode;
  tools: readonly ToolDefinition[];
  toolIds: ReadonlySet<string>;
  skills: readonly SkillEntry[];
  skillIds: ReadonlySet<string>;
}

export interface ResolveRunCapabilitiesInput {
  mode: ConversationMode;
  activeSearchBackend: SearchBackend;
  toolModeOverrides?: ToolModeOverrides;
  skillModeOverrides?: SkillModeOverrides;
  /** Chat 模式工具增强总开关（general-settings.chatToolsEnabled）。 */
  chatToolsEnabled?: boolean;
  toolRegistry: { getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ToolDefinition[] };
  skillRegistry: { getEnabledForMode(mode: SkillMode, overrides?: SkillModeOverrides): SkillEntry[] };
}

export function resolveRunCapabilities(input: ResolveRunCapabilitiesInput): RunCapabilities {
  if (input.mode === "chat") {
    // Chat 工具增强：总开关开启时仅放行 Chat tab 显式勾选（override.chat===true）
    // 的工具——严格 opt-in，不走"未声明 modes 即全可见"的默认规则，
    // 防止 fs/git 等未声明 modes 的工具意外漏进闲聊会话。Skill 恒不暴露。
    if (!input.chatToolsEnabled) {
      return { mode: input.mode, tools: [], toolIds: new Set(), skills: [], skillIds: new Set() };
    }
    const optInTools = input.toolRegistry
      .getEnabledToolsForMode("chat", input.toolModeOverrides)
      .filter((tool) => input.toolModeOverrides?.[tool.id]?.chat === true);
    const tools = filterToolsBySearchBackend(optInTools, input.activeSearchBackend);
    return {
      mode: input.mode,
      tools,
      toolIds: new Set(tools.map((tool) => tool.id)),
      skills: [],
      skillIds: new Set(),
    };
  }
  const tools = filterToolsBySearchBackend(
    input.toolRegistry.getEnabledToolsForMode(input.mode, input.toolModeOverrides),
    input.activeSearchBackend,
  );
  const skills = input.skillRegistry.getEnabledForMode(input.mode, input.skillModeOverrides);
  return { mode: input.mode, tools, toolIds: new Set(tools.map((tool) => tool.id)), skills, skillIds: new Set(skills.map((skill) => skill.id)) };
}
