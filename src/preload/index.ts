import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc-channels";

const cyreneApi = {
  minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  hide: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  quit: () => ipcRenderer.send(IPC.APP_QUIT),
  setInteractive: (interactive: boolean) =>
    ipcRenderer.invoke(IPC.WINDOW_SET_INTERACTIVE, interactive),
  moveBy: (dx: number, dy: number) =>
    ipcRenderer.send(IPC.WINDOW_MOVE, dx, dy),
  moveTo: (x: number, y: number) =>
    ipcRenderer.send(IPC.WINDOW_MOVE_TO, x, y),
  setDragging: (isDragging: boolean) =>
    ipcRenderer.send(IPC.WINDOW_SET_DRAGGING, isDragging),
  captureFrame: () => ipcRenderer.invoke(IPC.WINDOW_CAPTURE_FRAME),
  getCursorPosition: () => ipcRenderer.invoke(IPC.WINDOW_GET_CURSOR_POSITION),
  onPetZoom: (callback: (zoom: number) => void) => {
    const listener = (_e: unknown, zoom: number) => callback(zoom);
    ipcRenderer.on(IPC.PET_ZOOM, listener);
    return () => ipcRenderer.off(IPC.PET_ZOOM, listener);
  },
};

const chatApi = {
  minimize: () => ipcRenderer.send(IPC.CHAT_MINIMIZE),
  close: () => ipcRenderer.send(IPC.CHAT_CLOSE),
  toggleMaximize: () => ipcRenderer.send(IPC.CHAT_TOGGLE_MAXIMIZE),
  isMaximized: () => ipcRenderer.invoke(IPC.CHAT_IS_MAXIMIZED),
  sendMessage: (messages: unknown[], style: string) => ipcRenderer.invoke(IPC.CHAT_SEND_MESSAGE, messages, style),
  getEnabledStickers: () => ipcRenderer.invoke(IPC.STICKERS_GET_ENABLED),
  /** 从 dataTransfer.files 或 fileInput.files 提取路径后批量摄入。
   *  路径提取在 preload（webUtils.getPathForFile），避免 Electron 33 中 File.path 不可用的问题。 */
  ingestDroppedFiles: async (files: File[]): Promise<unknown[]> => {
    const paths: string[] = [];
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch { /* 跳过无法识别路径的文件 */ }
    }
    if (paths.length === 0) return [];
    return ipcRenderer.invoke(IPC.CHAT_INGEST_FILES, paths);
  },
  onStreamChunk: (cb: (chunk: string) => void) => { ipcRenderer.on(IPC.CHAT_STREAM_CHUNK, (_e: unknown, chunk: string) => cb(chunk)); },
  onStreamDone: (cb: (payload: unknown) => void) => { ipcRenderer.on(IPC.CHAT_STREAM_DONE, (_e: unknown, payload: unknown) => cb(payload)); },
  removeStreamListeners: () => { ipcRenderer.removeAllListeners(IPC.CHAT_STREAM_CHUNK); ipcRenderer.removeAllListeners(IPC.CHAT_STREAM_DONE); },
};

contextBridge.exposeInMainWorld("cyrene", cyreneApi);
contextBridge.exposeInMainWorld("chat", chatApi);

// AG-UI 事件流：发起一次 agent run，通过 onEvent 回调收 AG-UI 标准事件，
// 返回 Promise<{success,error}> 表示整轮结束。onEvent 返回的取消订阅函数用于停止监听。
const aguiApi = {
  run: (input: { messages: unknown[]; style: string; sessionId?: string; attachments?: { name: string; text: string }[] }) =>
    ipcRenderer.invoke(IPC.AGUI_RUN, input) as Promise<{ success: boolean; error?: string }>,
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => {
      try {
        callback(event);
      } catch (err) {
        console.error("[Preload] listener抛错:", err);
      }
    };
    ipcRenderer.on(IPC.AGUI_EVENT, listener);
    return () => ipcRenderer.off(IPC.AGUI_EVENT, listener);
  },
  cancel: () => ipcRenderer.invoke(IPC.AGUI_CANCEL),
};

contextBridge.exposeInMainWorld("agui", aguiApi);

const schedulerEventsApi = {
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => {
      try {
        callback(event);
      } catch (err) {
        console.error("[Preload] scheduler listener抛错:", err);
      }
    };
    ipcRenderer.on(IPC.SCHEDULER_EVENT, listener);
    return () => ipcRenderer.off(IPC.SCHEDULER_EVENT, listener);
  },
};

contextBridge.exposeInMainWorld("schedulerEvents", schedulerEventsApi);

// 用户选择卡片（歧义消解器）：渲染端回传用户选择给主进程
// 卡片展示走 AGUI_EVENT 的 CUSTOM 事件（与天气卡片同通道），resolve 走独立 IPC
const choiceApi = {
  resolve: (id: string, value: string) =>
    ipcRenderer.invoke(IPC.CHOICE_RESOLVE, { id, value }),
};
contextBridge.exposeInMainWorld("choice", choiceApi);

const sidebarApi = {
  minimize: () => ipcRenderer.send(IPC.SIDEBAR_MINIMIZE),
  close: () => ipcRenderer.send(IPC.SIDEBAR_CLOSE),
  toggleAlwaysOnTop: () => ipcRenderer.invoke(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP),
  openTasks: () => ipcRenderer.send(IPC.SIDEBAR_OPEN_TASKS),
  openSettings: (section?: string) => ipcRenderer.send(IPC.SIDEBAR_OPEN_SETTINGS, section),
  openCall: () => ipcRenderer.send(IPC.SIDEBAR_OPEN_CALL),
};

const tasksApi = {
  minimize: () => ipcRenderer.send(IPC.TASKS_MINIMIZE),
  close: () => ipcRenderer.send(IPC.TASKS_CLOSE),
  onSchedulerChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.SCHEDULER_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_CHANGED, handler);
  },
};

contextBridge.exposeInMainWorld("sidebar", sidebarApi);
contextBridge.exposeInMainWorld("tasks", tasksApi);

// 通话窗口 API
const callApi = {
  start: () => ipcRenderer.send(IPC.CALL_START),
  sendAudioFrame: (frame: ArrayBuffer) => ipcRenderer.send(IPC.CALL_AUDIO_FRAME, frame),
  turnEnd: () => ipcRenderer.send(IPC.CALL_TURN_END),
  ttsDone: () => ipcRenderer.send(IPC.CALL_TTS_DONE),
  stop: () => ipcRenderer.send(IPC.CALL_STOP),
  onState: (callback: (state: string) => void) => {
    const handler = (_event: unknown, data: { state: string }) => callback(data.state);
    ipcRenderer.on(IPC.CALL_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_STATE, handler);
  },
  onAsrResult: (callback: (data: { partial?: string; final?: string }) => void) => {
    const handler = (_event: unknown, data: { partial?: string; final?: string }) => callback(data);
    ipcRenderer.on(IPC.CALL_ASR_RESULT, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_ASR_RESULT, handler);
  },
  onTtsAudio: (callback: (data: { base64: string }) => void) => {
    const handler = (_event: unknown, data: { base64: string }) => callback(data);
    ipcRenderer.on(IPC.CALL_TTS_AUDIO, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_TTS_AUDIO, handler);
  },
  onError: (callback: (data: { message: string }) => void) => {
    const handler = (_event: unknown, data: { message: string }) => callback(data);
    ipcRenderer.on(IPC.CALL_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_ERROR, handler);
  },
};
contextBridge.exposeInMainWorld("call", callApi);

const settingsApi = {
  minimize: () => ipcRenderer.send(IPC.SETTINGS_MINIMIZE),
  close: () => ipcRenderer.send(IPC.SETTINGS_CLOSE),
  getConfig: () => ipcRenderer.invoke(IPC.SETTINGS_GET_CONFIG),
  saveConfig: (config: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE_CONFIG, config),
  testConnection: (config: { provider: string; baseUrl: string; model: string; apiKey: string }) => ipcRenderer.invoke(IPC.SETTINGS_TEST_CONNECTION, config),
  testVision: (config: { baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke(IPC.SETTINGS_TEST_VISION, config),
  // main → settings：要求切到指定标签（窗口已打开时由 main 发这个事件）
  onSwitchSection: (callback: (section: string) => void) => {
    const listener = (_e: unknown, section: string) => callback(section);
    ipcRenderer.on(IPC.SETTINGS_SWITCH_SECTION, listener);
    return () => ipcRenderer.off(IPC.SETTINGS_SWITCH_SECTION, listener);
  },
  getGeneral: () => ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL),
  saveGeneral: (config: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE_GENERAL, config),
  openSidebar: () => ipcRenderer.send(IPC.SETTINGS_OPEN_SIDEBAR),
  closeSidebar: () => ipcRenderer.send(IPC.SETTINGS_CLOSE_SIDEBAR),
  openTasks: () => ipcRenderer.send(IPC.SETTINGS_OPEN_TASKS),
  closeTasks: () => ipcRenderer.send(IPC.SETTINGS_CLOSE_TASKS),
  setPetAlwaysOnTop: (value: boolean) => ipcRenderer.send(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, value),
  setPetVisible: (value: boolean) => ipcRenderer.send(IPC.SETTINGS_SET_PET_VISIBLE, value),
  setPetZoom: (value: number) => ipcRenderer.send(IPC.SETTINGS_SET_PET_ZOOM, value),
  previewRuntimeSync: (value: "off" | "local" | "llm") => ipcRenderer.send(IPC.SETTINGS_PREVIEW_RUNTIME_SYNC, value),
  openStickerManager: () => ipcRenderer.invoke(IPC.SETTINGS_OPEN_STICKER_MANAGER),
  stickerPickFile: () => ipcRenderer.invoke(IPC.STICKERS_PICK_FILE),
  stickerAdd: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) => ipcRenderer.invoke(IPC.STICKERS_ADD, payload),
  getEmbeddingStatus: () => ipcRenderer.invoke(IPC.EMBEDDING_GET_STATUS),
  downloadEmbeddingModel: (model: string, mirror: string) => ipcRenderer.invoke(IPC.EMBEDDING_DOWNLOAD, { model, mirror }),
  deleteEmbeddingModel: (model: string) => ipcRenderer.invoke(IPC.EMBEDDING_DELETE, { model }),
  embeddingSetModel: (model: string) => ipcRenderer.invoke(IPC.EMBEDDING_SET_MODEL, model),
  rerankerSetMode: (mode: string) => ipcRenderer.invoke(IPC.RERANKER_SET_MODE, mode),
  setToolEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.TOOL_SET_ENABLED, { id, enabled }),
  getToolEnabled: () => ipcRenderer.invoke(IPC.TOOL_GET_ENABLED),
  listSkills: () => ipcRenderer.invoke(IPC.SKILL_LIST),
  setSkillEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.SKILL_SET_ENABLED, { id, enabled }),
  addMcpServer: (config: unknown) => ipcRenderer.invoke(IPC.MCP_ADD_SERVER, config),
  removeMcpServer: (serverId: string) => ipcRenderer.invoke(IPC.MCP_REMOVE_SERVER, serverId),
  listMcpServers: () => ipcRenderer.invoke(IPC.MCP_LIST_SERVERS),
  // 权限档位
  getPermissionLevel: () => ipcRenderer.invoke(IPC.PERMISSION_GET_LEVEL),
  setPermissionLevel: (level: string) => ipcRenderer.invoke(IPC.PERMISSION_SET_LEVEL, level),
};

contextBridge.exposeInMainWorld("settings", settingsApi);

const schedulerApi = {
  list: () => ipcRenderer.invoke(IPC.SCHEDULER_LIST),
  add: (input: unknown) => ipcRenderer.invoke(IPC.SCHEDULER_ADD, input),
  update: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.SCHEDULER_UPDATE, id, patch),
  delete: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_DELETE, id),
  toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.SCHEDULER_TOGGLE, id, enabled),
  fireNow: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_FIRE_NOW, id),
  getHistory: (taskId: string, limit?: number) => ipcRenderer.invoke(IPC.SCHEDULER_GET_HISTORY, taskId, limit),
  getTools: () => ipcRenderer.invoke(IPC.SCHEDULER_GET_TOOLS),
};

contextBridge.exposeInMainWorld("cyreneScheduler", schedulerApi);

const stickerManagerApi = {
	  minimize: () => ipcRenderer.send(IPC.STICKERS_MINIMIZE),
	  close: () => ipcRenderer.send(IPC.STICKERS_CLOSE),
	  getConfig: () => ipcRenderer.invoke(IPC.STICKERS_GET_CONFIG),
	  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.STICKERS_SET_ENABLED, { id, enabled }),
	  pickFile: () => ipcRenderer.invoke(IPC.STICKERS_PICK_FILE),
	  addSticker: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) =>
	    ipcRenderer.invoke(IPC.STICKERS_ADD, payload),
	  deleteSticker: (id: string) => ipcRenderer.invoke(IPC.STICKERS_DELETE, id),
	};

contextBridge.exposeInMainWorld("stickerManager", stickerManagerApi);

const modelConfigApi = {
  get: () => ipcRenderer.invoke(IPC.MODEL_CONFIG_GET),
  onChanged: (callback: (config: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, config: unknown) => callback(config);
    ipcRenderer.on(IPC.MODEL_CONFIG_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.MODEL_CONFIG_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("modelConfig", modelConfigApi);
const runtimeStateApi = {
  get: () => ipcRenderer.invoke(IPC.RUNTIME_STATE_GET),
  onChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on(IPC.RUNTIME_STATE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.RUNTIME_STATE_CHANGED, listener);
  },
};

const userApi = {
  getProfile: () => ipcRenderer.invoke(IPC.USER_GET_PROFILE),
  saveProfile: (profile: unknown) => ipcRenderer.invoke(IPC.USER_SAVE_PROFILE, profile),
  uploadAvatar: () => ipcRenderer.invoke(IPC.USER_UPLOAD_AVATAR),
  getAvatar: () => ipcRenderer.invoke(IPC.USER_GET_AVATAR),
};

const memoryPanelApi = {
  getData: () => ipcRenderer.invoke(IPC.MEMORY_PANEL_GET_DATA),
  deleteImportedDoc: (importId: string, fileName?: string) => ipcRenderer.invoke(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, { importId, fileName }),
  saveL0: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.MEMORY_PANEL_SAVE_L0, patch),
  saveL1: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.MEMORY_PANEL_SAVE_L1, patch),
};

contextBridge.exposeInMainWorld("user", userApi);
contextBridge.exposeInMainWorld("memoryPanel", memoryPanelApi);
contextBridge.exposeInMainWorld("runtimeState", runtimeStateApi);

const live2dSpeechApi = {
  prepare: () => ipcRenderer.send(IPC.LIVE2D_SPEECH_PREPARE),
  startMouth: (durationMs: number) => ipcRenderer.send(IPC.LIVE2D_MOUTH_START, { durationMs }),
  stopMouth: () => ipcRenderer.send(IPC.LIVE2D_MOUTH_STOP),
  onPrepare: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.LIVE2D_SPEECH_PREPARE, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_SPEECH_PREPARE, listener);
  },
  onMouthStart: (callback: (payload: { durationMs: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { durationMs: number }) => callback(payload);
    ipcRenderer.on(IPC.LIVE2D_MOUTH_START, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_MOUTH_START, listener);
  },
  onMouthStop: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.LIVE2D_MOUTH_STOP, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_MOUTH_STOP, listener);
  },
  onShowBubble: (callback: (payload: import("../main/opener/opener-types").ShowBubblePayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: import("../main/opener/opener-types").ShowBubblePayload) => callback(payload);
    ipcRenderer.on(IPC.LIVE2D_SHOW_BUBBLE, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_SHOW_BUBBLE, listener);
  },
};
contextBridge.exposeInMainWorld("live2dSpeech", live2dSpeechApi);

// Opener 主动开口反馈（渲染端 → 主进程）
const openerApi = {
  feedback: (payload: { type: "clicked"; sceneId: string; itemId: string }) =>
    ipcRenderer.send(IPC.OPENER_FEEDBACK, payload),
  testFire: () => ipcRenderer.invoke(IPC.OPENER_TEST_FIRE),
};
contextBridge.exposeInMainWorld("openerBridge", openerApi);

// 聊天会话存储（多对话历史）
const chatStoreApi = {
  list: () => ipcRenderer.invoke(IPC.CHATS_LIST),
  get: (id: string) => ipcRenderer.invoke(IPC.CHATS_GET, id),
  create: (payload?: { title?: string; identityId?: string | null }) =>
    ipcRenderer.invoke(IPC.CHATS_CREATE, payload ?? {}),
  append: (id: string, message: unknown) =>
    ipcRenderer.invoke(IPC.CHATS_APPEND, { id, message }),
  replaceMessages: (id: string, messages: unknown[]) =>
    ipcRenderer.invoke(IPC.CHATS_REPLACE_MESSAGES, { id, messages }),
  rename: (id: string, title: string) =>
    ipcRenderer.invoke(IPC.CHATS_RENAME, { id, title }),
  delete: (id: string) => ipcRenderer.invoke(IPC.CHATS_DELETE, id),
  openFolder: () => ipcRenderer.invoke(IPC.CHATS_OPEN_FOLDER),
  migrateLegacy: (messages: unknown[]) =>
    ipcRenderer.invoke(IPC.CHATS_MIGRATE_LEGACY, messages),
  openInChatWindow: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CHATS_OPEN_IN_CHAT_WINDOW, sessionId),
  // 聊天窗口加载 / 切换 session 时上报；其他窗口可查询/订阅
  setActiveSession: (sessionId: string | null) =>
    ipcRenderer.invoke(IPC.CHATS_SET_ACTIVE_SESSION, sessionId),
  getActiveSession: () => ipcRenderer.invoke(IPC.CHATS_GET_ACTIVE_SESSION),
  onActiveSessionChanged: (callback: (sessionId: string | null) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string | null) => callback(sessionId);
    ipcRenderer.on(IPC.CHATS_ACTIVE_SESSION_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_ACTIVE_SESSION_CHANGED, listener);
  },
  // 任意会话变动后 main 广播；列表/聊天窗口订阅刷新
  onChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.CHATS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_CHANGED, listener);
  },
  // main → 聊天窗口：要求切到指定 sessionId（窗口已打开时用）
  onSwitchSession: (callback: (sessionId: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on(IPC.CHATS_SWITCH_SESSION, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_SWITCH_SESSION, listener);
  },
};

contextBridge.exposeInMainWorld("chatStore", chatStoreApi);

// Token 用量查询（设置中心 Token 面板用）
const tokenUsageApi = {
  get: (days: number) => ipcRenderer.invoke(IPC.TOKEN_USAGE_GET, days),
};
contextBridge.exposeInMainWorld("tokenUsage", tokenUsageApi);

// TTS 语音合成（设置中心 TTS 面板 + 聊天窗口朗读用）
const ttsApi = {
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") =>
    ipcRenderer.invoke(IPC.TTS_UPLOAD, { apiKey, filePath, purpose }),
  pickAudio: () => ipcRenderer.invoke(IPC.TTS_PICK_AUDIO),
  clone: (payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => ipcRenderer.invoke(IPC.TTS_CLONE, payload),
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE, payload),
  synthesizeCached: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED, payload),
  // GPT-SoVITS 本地 TTS（独立通道，payload 与 minimax 不同）
  synthesizeGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_GPTSOVITS, payload),
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED_GPTSOVITS, payload),
  // 选择音频文件（复用 TTS_PICK_AUDIO，gptsovits 选 ref audio 也用这个）
  pickAudioFile: () => ipcRenderer.invoke(IPC.TTS_PICK_AUDIO),
  // 流式语音合成（边合成边播）
  streamStart: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_STREAM_START, payload),
  onAudioChunk: (callback: (payload: { base64: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { base64: string }) => callback(payload);
    ipcRenderer.on(IPC.TTS_AUDIO_CHUNK, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_AUDIO_CHUNK, listener);
  },
  onStreamEnd: (callback: (payload: { cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }) => callback(payload);
    ipcRenderer.on(IPC.TTS_STREAM_END, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_STREAM_END, listener);
  },
  onStreamError: (callback: (payload: { message: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { message: string }) => callback(payload);
    ipcRenderer.on(IPC.TTS_STREAM_ERROR, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_STREAM_ERROR, listener);
  },
  saveSettings: (tts: Record<string, unknown>) => ipcRenderer.invoke(IPC.TTS_SAVE_SETTINGS, tts),
  loadSettings: () => ipcRenderer.invoke(IPC.TTS_LOAD_SETTINGS),
};
contextBridge.exposeInMainWorld("tts", ttsApi);

// 游戏代肝（插件卡：配置 + 参考图只读展示 + 开始停止）
const gameBotApi = {
  getConfig: () => ipcRenderer.invoke(IPC.GAME_BOT_GET_CONFIG),
  saveConfig: (config: unknown) => ipcRenderer.invoke(IPC.GAME_BOT_SAVE_CONFIG, config),
  listRecipes: () => ipcRenderer.invoke(IPC.GAME_BOT_LIST_RECIPES),
  listRefs: (recipeId: string) => ipcRenderer.invoke(IPC.GAME_BOT_LIST_REFS, recipeId),
  refsDir: (recipeId: string) => ipcRenderer.invoke(IPC.GAME_BOT_REFS_DIR, recipeId),
  start: () => ipcRenderer.invoke(IPC.GAME_BOT_START),
  stop: () => ipcRenderer.invoke(IPC.GAME_BOT_STOP),
  onProgress: (callback: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => callback(info);
    ipcRenderer.on(IPC.GAME_BOT_PROGRESS, listener);
    return () => ipcRenderer.off(IPC.GAME_BOT_PROGRESS, listener);
  },
};
contextBridge.exposeInMainWorld("gameBot", gameBotApi);

