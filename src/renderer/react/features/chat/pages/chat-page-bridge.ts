import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ConversationMode,
  ToolFileChange,
} from "../../../../../shared/chat-types";

export interface ChatStoreApi {
  list: (options?: { mode?: ConversationMode }) => Promise<ChatSessionMeta[]>;
  get: (id: string) => Promise<ChatSession | null>;
  create: (input: { identityId: null; mode: ConversationMode; title?: string }) => Promise<ChatSession>;
  append: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  upsert: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  replaceTail: (id: string, startIndex: number, messages: ChatMessage[]) => Promise<ChatSession | null>;
  setMessageTtsCacheKey: (id: string, messageId: string, cacheKey: string, converterVersion: string) => Promise<ChatSession | null>;
  rename: (id: string, title: string) => Promise<ChatSession | null>;
  delete: (id: string) => Promise<boolean>;
  setPinned: (id: string, pinned: boolean) => Promise<ChatSession | null>;
  setModelProfile: (id: string, modelProfileId?: string) => Promise<ChatSession | null>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string; isEmpty?: boolean }>;
  initLearnWorkspace: (sessionId: string) => Promise<{ ok: boolean; error?: string; created?: string[]; skipped?: string[] }>;
  openWorkspace: (workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  setActiveSession: (sessionId: string | null) => Promise<unknown>;
  onChanged: (callback: () => void) => () => void;
  onReactSwitchSession: (callback: (sessionId: string) => void) => () => void;
  notifyReactReady: () => void;
}

export interface SidebarApi {
  openSettings: (section?: string) => void;
}

export interface AguiEvent {
  type?: string;
  runId?: string;
  messageId?: string;
  delta?: string;
  message?: string;
  error?: string;
  content?: string;
  name?: string;
  value?: unknown;
  toolCallId?: string;
  toolCallName?: string;
  stepName?: string;
  status?: string;
  changes?: ToolFileChange[];
}

export interface AguiApi {
  run: (input: {
    messages: Array<{ role: "user" | "model"; content: string; at?: number }>;
    userTurnId: string;
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: Array<{ name: string; filePath: string; mime?: string }>;
    recoveryContext?: string;
    resumeFromRunId?: string;
    takeoverFromRunId?: string;
  }) => Promise<{ success: boolean; runId: string; error?: string }>;
  onEvent: (callback: (event: AguiEvent) => void) => () => void;
  cancel: (runId?: string) => Promise<unknown>;
  // 落盘确认（单向通知）：终态消息写入会话存储后上报，供插件轮次事件使用
  reportRunPersisted?: (payload: { runId: string; finalMessageId?: string }) => void;
  getInterruptedRun?: (sessionId: string) => Promise<{ runId: string; rounds: number; todoCount: number; updatedAt: number } | null>;
}

export interface ChoiceApi {
  resolve: (id: string, value: unknown) => Promise<{ ok: boolean }>;
}

export interface PermissionApprovalRequest {
  id: string;
  runId?: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: string;
}

export interface PermissionApprovalSettled {
  id: string;
  runId?: string;
  reason: "answered" | "cancelled" | "unavailable";
}

export interface SettingsApprovalApi {
  onPermissionApprovalRequest: (callback: (request: PermissionApprovalRequest) => void) => () => void;
  resolvePermissionApproval: (id: string, allowed: boolean) => Promise<{ ok: boolean }>;
  onPermissionApprovalSettled: (callback: (settlement: PermissionApprovalSettled) => void) => () => void;
}

export interface PublicModelConfig {
  model?: unknown;
  displayName?: string;
  stickerSize?: "small" | "standard" | "large";
}

export interface ModelConfigApi {
  get: () => Promise<PublicModelConfig>;
  onChanged: (callback: (config: PublicModelConfig) => void) => () => void;
}

export function chatStore(): ChatStoreApi | undefined {
  return (window as typeof window & { chatStore?: ChatStoreApi }).chatStore;
}

export function sidebarApi(): SidebarApi | undefined {
  return (window as typeof window & { sidebar?: SidebarApi }).sidebar;
}

export function aguiApi(): AguiApi | undefined {
  return (window as typeof window & { agui?: AguiApi }).agui;
}

export function choiceApi(): ChoiceApi | undefined {
  return (window as typeof window & { choice?: ChoiceApi }).choice;
}

export function settingsApprovalApi(): SettingsApprovalApi | undefined {
  return (window as typeof window & { settings?: SettingsApprovalApi }).settings;
}
