// IPC channel names shared between main and renderer
export const IPC = {
  // pet window
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_CLOSE: "window:close",
  WINDOW_DRAG_START: "window:drag-start",
  WINDOW_SET_INTERACTIVE: "window:set-interactive",
  WINDOW_MOVE: "window:move",
  WINDOW_MOVE_TO: "window:move-to",
  WINDOW_SET_DRAGGING: "window:set-dragging",
  WINDOW_CAPTURE_FRAME: "window:capture-frame",
  WINDOW_GET_CURSOR_POSITION: "window:get-cursor-position",
  APP_QUIT: "app:quit",

  // chat window
  CHAT_MINIMIZE: "chat:minimize",
  CHAT_CLOSE: "chat:close",
  CHAT_TOGGLE_MAXIMIZE: "chat:toggle-maximize",
  CHAT_IS_MAXIMIZED: "chat:is-maximized",
  CHAT_SEND_MESSAGE: "chat:send-message",
  CHAT_INGEST_FILES: "chat:ingest-files",
  CHAT_STREAM_CHUNK: "chat:stream-chunk",
  CHAT_STREAM_DONE: "chat:stream-done",

  // AG-UI 事件流（替换上面的 chat:stream-* 的新通道）
  AGUI_RUN: "agui:run",
  AGUI_EVENT: "agui:event",
  AGUI_CANCEL: "agui:cancel",
  SCHEDULER_EVENT: "scheduler:event",

  // sidebar window (status / schedule / settings entry)
  SIDEBAR_MINIMIZE: "sidebar:minimize",
  SIDEBAR_CLOSE: "sidebar:close",
  SIDEBAR_TOGGLE_ALWAYS_ON_TOP: "sidebar:toggle-always-on-top",
  SIDEBAR_OPEN_SETTINGS: "sidebar:open-settings",
  SIDEBAR_OPEN_TASKS: "sidebar:open-tasks",
  SIDEBAR_OPEN_CALL: "sidebar:open-call",

  // tasks window (read-only display, no per-element interactions)
  TASKS_CLOSE: "tasks:close",
  TASKS_MINIMIZE: "tasks:minimize",

  // settings window
  SETTINGS_MINIMIZE: "settings:minimize",
  SETTINGS_CLOSE: "settings:close",
  // main → settings 窗口：要求切到指定标签（已打开时用）
  SETTINGS_SWITCH_SECTION: "settings:switch-section",
  SETTINGS_GET_CONFIG: "settings:get-config",
  SETTINGS_SAVE_CONFIG: "settings:save-config",
  SETTINGS_TEST_CONNECTION: "settings:test-connection",
  SETTINGS_TEST_VISION: "settings:test-vision",
  SETTINGS_GET_GENERAL: "settings:get-general",
  SETTINGS_SAVE_GENERAL: "settings:save-general",
  SETTINGS_OPEN_SIDEBAR: "settings:open-sidebar",
  SETTINGS_CLOSE_SIDEBAR: "settings:close-sidebar",
  SETTINGS_OPEN_TASKS: "settings:open-tasks",
  SETTINGS_CLOSE_TASKS: "settings:close-tasks",
  SETTINGS_SET_PET_ALWAYS_ON_TOP: "settings:set-pet-always-on-top",
  SETTINGS_SET_PET_VISIBLE: "settings:set-pet-visible",
  SETTINGS_SET_PET_ZOOM: "settings:set-pet-zoom",
  // main → pet window：推送当前 zoom 因子，渲染进程据此重算 scale
  PET_ZOOM: "pet:zoom",
  SETTINGS_PREVIEW_RUNTIME_SYNC: "settings:preview-runtime-sync",
  SETTINGS_OPEN_STICKER_MANAGER: "settings:open-sticker-manager",

  // chat sessions (multi-conversation history, persisted to userData/cyrene-chats/)
  CHATS_LIST: "chats:list",
  CHATS_GET: "chats:get",
  CHATS_CREATE: "chats:create",
  CHATS_APPEND: "chats:append",
  CHATS_REPLACE_MESSAGES: "chats:replace-messages",
  CHATS_RENAME: "chats:rename",
  CHATS_DELETE: "chats:delete",
  CHATS_OPEN_FOLDER: "chats:open-folder",
  CHATS_MIGRATE_LEGACY: "chats:migrate-legacy",
  // 任意会话变动后 main → 所有渲染窗口 broadcast，触发列表/标题刷新
  CHATS_CHANGED: "chats:changed",
  // 设置中心 → main：要求打开聊天窗口并加载指定 sessionId
  CHATS_OPEN_IN_CHAT_WINDOW: "chats:open-in-chat-window",
  // main → 聊天窗口：要求切到指定 sessionId（窗口已存在时用）
  CHATS_SWITCH_SESSION: "chats:switch-session",
  // 聊天窗口 → main：声明当前活跃 sessionId（用于设置面板"删除当前会话"时差异化提示）
  CHATS_SET_ACTIVE_SESSION: "chats:set-active-session",
  // renderer → main: 查询当前活跃 sessionId（设置面板初次打开时用）
  CHATS_GET_ACTIVE_SESSION: "chats:get-active-session",
  // main → 所有窗口：活跃 sessionId 变化时广播
  CHATS_ACTIVE_SESSION_CHANGED: "chats:active-session-changed",

// sticker manager window
	  STICKERS_MINIMIZE: "stickers:minimize",
	  STICKERS_CLOSE: "stickers:close",
	  STICKERS_GET_CONFIG: "stickers:get-config",
	  STICKERS_SET_ENABLED: "stickers:set-enabled",
	  STICKERS_PICK_FILE: "stickers:pick-file",
	  STICKERS_ADD: "stickers:add",
	  STICKERS_DELETE: "stickers:delete",
	  STICKERS_GET_ENABLED: "stickers:get-enabled",

  // public model config updates (no API key)
  MODEL_CONFIG_GET: "model-config:get",
  MODEL_CONFIG_CHANGED: "model-config:changed",

  // runtime state updates (status / feeling / expression)
  RUNTIME_STATE_GET: "runtime-state:get",
  RUNTIME_STATE_CHANGED: "runtime-state:changed",

  // Live2D speech / mouth sync
  LIVE2D_SPEECH_PREPARE: "live2d:speech-prepare",
  LIVE2D_MOUTH_START: "live2d:mouth-start",
  LIVE2D_MOUTH_STOP: "live2d:mouth-stop",
  // Opener 主动开口
  LIVE2D_SHOW_BUBBLE: "live2d:show-bubble",       // 主进程 → 桌宠窗口：显示气泡+播 wav
  OPENER_FEEDBACK: "opener:feedback",             // 渲染端 → 主进程：点气泡反馈
  OPENER_TEST_FIRE: "opener:test-fire",           // 渲染端 → 主进程：手动测试气泡
  // embedding model status
  EMBEDDING_GET_STATUS: "embedding:get-status",
  EMBEDDING_DOWNLOAD: "embedding:download",
  EMBEDDING_DELETE: "embedding:delete",
  EMBEDDING_PROGRESS: "embedding:progress",
  EMBEDDING_SET_MODEL: "embedding:set-model",
  RERANKER_SET_MODE: "reranker:set-mode",
  // user profile
  USER_GET_PROFILE: "user:get-profile",
  USER_SAVE_PROFILE: "user:save-profile",
  USER_UPLOAD_AVATAR: "user:upload-avatar",
  USER_GET_AVATAR: "user:get-avatar",

  // memory panel
  MEMORY_PANEL_GET_DATA: "memory-panel:get-data",
  MEMORY_PANEL_DELETE_IMPORTED_DOC: "memory-panel:delete-imported-doc",
  MEMORY_PANEL_SAVE_L0: "memory-panel:save-l0",
  MEMORY_PANEL_SAVE_L1: "memory-panel:save-l1",

  // MCP server management
  MCP_ADD_SERVER: "mcp:add-server",
  MCP_REMOVE_SERVER: "mcp:remove-server",
  MCP_LIST_SERVERS: "mcp:list-servers",

  // tool (plugin) toggle
  TOOL_SET_ENABLED: "tool:set-enabled",
  TOOL_GET_ENABLED: "tool:get-enabled",

  // skill toggle
  SKILL_LIST: "skill:list",
  SKILL_SET_ENABLED: "skill:set-enabled",

  // scheduled tasks
  SCHEDULER_LIST: "scheduler:list",
  SCHEDULER_ADD: "scheduler:add",
  SCHEDULER_UPDATE: "scheduler:update",
  SCHEDULER_DELETE: "scheduler:delete",
  SCHEDULER_TOGGLE: "scheduler:toggle",
  SCHEDULER_FIRE_NOW: "scheduler:fire-now",
  SCHEDULER_GET_HISTORY: "scheduler:get-history",
  SCHEDULER_GET_TOOLS: "scheduler:get-tools",
  SCHEDULER_CHANGED: "scheduler:changed",  // main → renderer：任务列表变更通知

  // game-bot（游戏代肝）
  GAME_BOT_GET_CONFIG: "game-bot:get-config",
  GAME_BOT_SAVE_CONFIG: "game-bot:save-config",
  GAME_BOT_LIST_RECIPES: "game-bot:list-recipes",
  GAME_BOT_LIST_REFS: "game-bot:list-refs",
  GAME_BOT_REFS_DIR: "game-bot:refs-dir",
  GAME_BOT_START: "game-bot:start",
  GAME_BOT_STOP: "game-bot:stop",
  GAME_BOT_PROGRESS: "game-bot:progress",

  // token usage statistics
  TOKEN_USAGE_GET: "token-usage:get",

  // TTS 语音合成
  TTS_UPLOAD: "tts:upload",          // 上传音频文件 → file_id
  TTS_CLONE: "tts:clone",           // 音色快速复刻 → voice_id
  TTS_SYNTHESIZE: "tts:synthesize", // 语音合成 → audio buffer(base64)
  TTS_SYNTHESIZE_CACHED: "tts:synthesize-cached", // 语音合成 + 本地音频缓存
  // 流式语音合成（边合成边播，首字延迟低）
  TTS_STREAM_START: "tts:stream-start",           // 渲染端 → main：启动流式合成
  TTS_AUDIO_CHUNK: "tts:audio-chunk",             // main → 渲染端：推一段音频 base64
  TTS_STREAM_END: "tts:stream-end",               // main → 渲染端：流式结束（含 cacheKey）
  TTS_STREAM_ERROR: "tts:stream-error",           // main → 渲染端：流式错误
  TTS_SAVE_SETTINGS: "tts:save-settings",   // 保存 TTS 配置
  TTS_LOAD_SETTINGS: "tts:load-settings",   // 加载 TTS 配置
  TTS_PICK_AUDIO: "tts:pick-audio",         // 选择音频文件（dialog）
  TTS_SYNTHESIZE_GPTSOVITS: "tts:synthesize-gptsovits",             // GPT-SoVITS 合成 → base64
  TTS_SYNTHESIZE_CACHED_GPTSOVITS: "tts:synthesize-cached-gptsovits", // GPT-SoVITS 合成 + 本地缓存

  // agent permission level (file/shell access)
  PERMISSION_GET_LEVEL: "permission:get-level",
  PERMISSION_SET_LEVEL: "permission:set-level",
  // main → renderer：要求审批
  PERMISSION_APPROVAL_REQUEST: "permission:approval-request",
  // renderer → main：审批结果回传
  PERMISSION_APPROVAL_RESOLVE: "permission:approval-resolve",

  // user choice card (ambiguity resolver)
  // 卡片展示走 AGUI_EVENT 的 CUSTOM 事件（与天气卡片同通道）
  // renderer → main：回传用户选择
  CHOICE_RESOLVE: "choice:resolve",

  // call window (voice call)
  CALL_OPEN: "call:open",                 // sidebar → main：打开通话窗口
  CALL_START: "call:start",               // renderer → main：开始通话（初始化 ASR）
  CALL_AUDIO_FRAME: "call:audio-frame",    // renderer → main：PCM 音频帧
  CALL_ASR_RESULT: "call:asr-result",     // main → renderer：ASR 识别结果
  CALL_TURN_END: "call:turn-end",         // renderer → main：VAD 静默，结束本轮
  CALL_TTS_AUDIO: "call:tts-audio",       // main → renderer：TTS 音频
  CALL_TTS_DONE: "call:tts-done",         // renderer → main：TTS 播放完毕
  CALL_STATE: "call:state",               // main → renderer：状态变更
  CALL_ERROR: "call:error",               // main → renderer：错误
  CALL_STOP: "call:stop",                 // renderer → main：挂断
} as const;

