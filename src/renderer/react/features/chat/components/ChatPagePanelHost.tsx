import type { ChatPagePanel } from "./ChatPageNavigation";
import { ModelModePanel } from "./ModelModePanel";
import { PluginModePanel } from "./PluginModePanel";
import { SkillModePanel } from "./SkillModePanel";
import { ToolModePanel } from "./ToolModePanel";

export function ChatPagePanelHost({ panel }: { panel: ChatPagePanel }) {
  switch (panel) {
    case "model": return <ModelModePanel />;
    case "plugin": return <PluginModePanel />;
    case "skill": return <SkillModePanel />;
    case "tool": return <ToolModePanel />;
  }
}
