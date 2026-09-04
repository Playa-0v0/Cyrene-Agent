import React from "react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { ModelModeButton } from "../../../components/ui/ModelModeButton";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { PluginModeButton } from "../../../components/ui/PluginModeButton";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { SkillModeButton } from "../../../components/ui/SkillModeButton";
import { ToolModeButton } from "../../../components/ui/ToolModeButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { WindowControls } from "../../../components/ui/WindowControls";
import { AppUpdateEntry } from "./AppUpdateEntry";
import { ConversationSidebar } from "./ConversationSidebar";

export type ChatPagePanel = "tool" | "skill" | "model" | "plugin";

export interface ChatPageNavigationProps {
  collapsed: boolean;
  activePanel: ChatPagePanel | null;
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  activeSessionId?: string;
  onToggleCollapsed: () => void;
  onModeChange: (mode: string) => void;
  onNewTask: () => void;
  onTogglePanel: (panel: ChatPagePanel) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string, pinned: boolean) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onCloseWindow: () => void;
  onOpenSettings: () => void;
}

export function ChatPageNavigation({
  collapsed,
  activePanel,
  mode,
  sessions,
  activeSessionId,
  onToggleCollapsed,
  onModeChange,
  onNewTask,
  onTogglePanel,
  onSelectSession,
  onOpenProject,
  onRenameSession,
  onDeleteSession,
  onTogglePinSession,
  onMinimize,
  onMaximize,
  onCloseWindow,
  onOpenSettings,
}: ChatPageNavigationProps) {
  const hasOpenPanel = activePanel !== null;

  return (
    <>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
      </div>
      <div className="cy-page-top-center">
        {!hasOpenPanel && <ModeSwitch value={mode} onChange={onModeChange} />}
      </div>
      <div className="cy-page-windows">
        <WindowControls onMinimize={onMinimize} onMaximize={onMaximize} onClose={onCloseWindow} />
      </div>
      <div className="cy-page-sidebar">
        <div className="cy-page-newtask">
          <NewTaskButton onClick={onNewTask} />
          <ToolModeButton active={activePanel === "tool"} onClick={() => onTogglePanel("tool")} />
          <SkillModeButton active={activePanel === "skill"} onClick={() => onTogglePanel("skill")} />
          <ModelModeButton active={activePanel === "model"} onClick={() => onTogglePanel("model")} />
          <PluginModeButton active={activePanel === "plugin"} onClick={() => onTogglePanel("plugin")} />
        </div>
        <div className="cy-page-conversations">
          <ConversationSidebar
            mode={mode}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={onSelectSession}
            onOpenProject={onOpenProject}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
            onTogglePin={onTogglePinSession}
          />
        </div>
        <AppUpdateEntry />
        <div className="cy-page-sidebar-bottom">
          <UserAvatar />
          <SettingsButton onClick={onOpenSettings} />
        </div>
      </div>
    </>
  );
}
