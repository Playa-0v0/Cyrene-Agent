// IPC channel names shared between main and renderer
export const IPC = {
  // pet window
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_CLOSE: "window:close",
  WINDOW_DRAG_START: "window:drag-start",
  WINDOW_SET_INTERACTIVE: "window:set-interactive",
  WINDOW_SET_TEXT_INPUT_ACTIVE: "window:set-text-input-active",
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
  PET_CHAT_SEND: "pet-chat:send",
  PET_CHAT_INPUT_VISIBILITY: "pet-chat:input-visibility",
  CHAT_INGEST_FILES: "chat:ingest-files",
  CHAT_STREAM_CHUNK: "chat:stream-chunk",
  CHAT_STREAM_DONE: "chat:stream-done",

  // AG-UI 事件流（替換上面的 chat:stream-* 的新通道）
  AGUI_RUN: "agui:run",
  AGUI_EVENT: "agui:event",
  AGUI_CANCEL: "agui:cancel",
  SCHEDULER_EVENT: "scheduler:event",

  // sidebar window (status / schedule / settings entry)
  SIDEBAR_MINIMIZE: "sidebar:minimize",
  SIDEBAR_CLOSE: "sidebar:close",
  SIDEBAR_TOGGLE_MAXIMIZE: "sidebar:toggle-maximize",
  SIDEBAR_TOGGLE_ALWAYS_ON_TOP: "sidebar:toggle-always-on-top",
  SIDEBAR_OPEN_SETTINGS: "sidebar:open-settings",
  SIDEBAR_OPEN_TASKS: "sidebar:open-tasks",
  SIDEBAR_OPEN_CALL: "sidebar:open-call",
  SIDEBAR_SET_PET_DOCK_VISIBLE: "sidebar:set-pet-dock-visible",

  // tasks window (read-only display, no per-element interactions)
  TASKS_CLOSE: "tasks:close",
  TASKS_MINIMIZE: "tasks:minimize",

  // settings window
  SETTINGS_MINIMIZE: "settings:minimize",
  SETTINGS_CLOSE: "settings:close",
  // main → settings 窗口：要求切到指定標籤（已打開時用）
  SETTINGS_SWITCH_SECTION: "settings:switch-section",
  SETTINGS_GET_CONFIG: "settings:get-config",
  SETTINGS_SAVE_CONFIG: "settings:save-config",
  SETTINGS_TEST_CONNECTION: "settings:test-connection",
  SETTINGS_TEST_VISION: "settings:test-vision",
  SETTINGS_GET_GENERAL: "settings:get-general",
  SETTINGS_SAVE_GENERAL: "settings:save-general",
  UI_THEME_GET: "ui-theme:get",
  UI_THEME_CHANGED: "ui-theme:changed",
  SETTINGS_OPEN_SIDEBAR: "settings:open-sidebar",
  SETTINGS_CLOSE_SIDEBAR: "settings:close-sidebar",
  SETTINGS_OPEN_TASKS: "settings:open-tasks",
  SETTINGS_CLOSE_TASKS: "settings:close-tasks",
  SETTINGS_SET_PET_ALWAYS_ON_TOP: "settings:set-pet-always-on-top",
  SETTINGS_SET_PET_VISIBLE: "settings:set-pet-visible",
  SETTINGS_SET_PET_ZOOM: "settings:set-pet-zoom",
  // main → pet window：推送當前 zoom 因子，渲染進程據此重算 scale
  PET_ZOOM: "pet:zoom",
  SETTINGS_PREVIEW_RUNTIME_SYNC: "settings:preview-runtime-sync",
  SETTINGS_OPEN_STICKER_MANAGER: "settings:open-sticker-manager",
  SECURITY_GET_STATUS: "security:get-status",
  SECURITY_MIGRATE: "security:migrate",
  SECURITY_RESTART_APP: "security:restart-app",
  BACKUP_GET_CONFIG: "backup:get-config",
  BACKUP_SAVE_CONFIG: "backup:save-config",
  BACKUP_CREATE: "backup:create",
  BACKUP_PICK_INSPECT: "backup:pick-inspect",
  BACKUP_RESTORE: "backup:restore",

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
  // 任意會話變動後 main → 所有渲染窗口 broadcast，觸發列表/標題刷新
  CHATS_CHANGED: "chats:changed",
  // 設置中心 → main：要求打開聊天窗口並加載指定 sessionId
  CHATS_OPEN_IN_CHAT_WINDOW: "chats:open-in-chat-window",
  // main → 聊天窗口：要求切到指定 sessionId（窗口已存在時用）
  CHATS_SWITCH_SESSION: "chats:switch-session",
  // 聊天窗口 → main：聲明當前活躍 sessionId（用於設置面板"刪除當前會話"時差異化提示）
  CHATS_SET_ACTIVE_SESSION: "chats:set-active-session",
  // renderer → main: 查詢當前活躍 sessionId（設置面板初次打開時用）
  CHATS_GET_ACTIVE_SESSION: "chats:get-active-session",
  // main → 所有窗口：活躍 sessionId 變化時廣播
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
  CONNECTION_STATUS_GET: "connection-status:get",
  RUNTIME_STATE_CHANGED: "runtime-state:changed",

  // Live2D speech / mouth sync
  LIVE2D_SPEECH_PREPARE: "live2d:speech-prepare",
  LIVE2D_MOUTH_START: "live2d:mouth-start",
  LIVE2D_MOUTH_STOP: "live2d:mouth-stop",
  // Opener 主動開口
  LIVE2D_SHOW_BUBBLE: "live2d:show-bubble",       // 主進程 → 桌寵窗口：顯示氣泡+播 wav
  LIVE2D_PLAY_ACTION: "live2d:play-action",        // 主進程 → 桌寵窗口：執行動作（motion 或 expression）
  OPENER_FEEDBACK: "opener:feedback",             // 渲染端 → 主進程：點氣泡反饋
  OPENER_TEST_FIRE: "opener:test-fire",           // 渲染端 → 主進程：手動測試氣泡
  OPENER_GET_STATUS: "opener:get-status",         // 渲染端 → 主進程：讀取語音包與運行狀態
  OPENER_OPEN_PACK_FOLDER: "opener:open-pack-folder", // 打開自定義語音包目錄
  // embedding model status
  EMBEDDING_GET_STATUS: "embedding:get-status",
  EMBEDDING_DOWNLOAD: "embedding:download",
  EMBEDDING_DELETE: "embedding:delete",
  EMBEDDING_PROGRESS: "embedding:progress",
  EMBEDDING_SET_MODEL: "embedding:set-model",
  RERANKER_SET_MODE: "reranker:set-mode",
  RERANKER_GET_STATUS: "reranker:get-status",
  // unified model install status
  MODEL_GET_INSTALL_STATUS: "model:get-install-status",
  // shell external URL
  OPEN_EXTERNAL: "shell:open-external",
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
  MEMORY_PANEL_PIN_L2: "memory-panel:pin-l2",
  MEMORY_PANEL_DELETE_L2: "memory-panel:delete-l2",

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
  SCHEDULER_CHANGED: "scheduler:changed",  // main → renderer：任務列表變更通知

  // game-bot（遊戲代肝）
  GAME_BOT_GET_CONFIG: "game-bot:get-config",
  GAME_BOT_SAVE_CONFIG: "game-bot:save-config",
  GAME_BOT_LIST_RECIPES: "game-bot:list-recipes",
  GAME_BOT_LIST_REFS: "game-bot:list-refs",
  GAME_BOT_REFS_DIR: "game-bot:refs-dir",
  GAME_BOT_START: "game-bot:start",
  GAME_BOT_STOP: "game-bot:stop",
  GAME_BOT_PROGRESS: "game-bot:progress",

  // game room（與昔漣一起玩的內建小遊戲）
  GAME_ROOM_GET_STATS: "game-room:get-stats",
  GAME_ROOM_RECORD_RESULT: "game-room:record-result",
  GAME_ROOM_RESET_STATS: "game-room:reset-stats",
  GAME_ROOM_REACT: "game-room:react",

  // token usage statistics
  TOKEN_USAGE_GET: "token-usage:get",
  CALL_USAGE_GET: "call-usage:get",
  AGENT_ACTIVITY_GET: "agent-activity:get",
  AGENT_DIAGNOSTIC_EXPORT: "agent-diagnostic:export",
  ASR_TEST_LOCAL: "asr:test-local",

  // TTS 語音合成
  TTS_UPLOAD: "tts:upload",          // 上傳音頻文件 → file_id
  TTS_CLONE: "tts:clone",           // 音色快速復刻 → voice_id
  TTS_SYNTHESIZE: "tts:synthesize", // 語音合成 → audio buffer(base64)
  TTS_SYNTHESIZE_CACHED: "tts:synthesize-cached", // 語音合成 + 本地音頻緩存
  // 流式語音合成（邊合成邊播，首字延遲低）
  TTS_STREAM_START: "tts:stream-start",           // 渲染端 → main：啟動流式合成
  TTS_AUDIO_CHUNK: "tts:audio-chunk",             // main → 渲染端：推一段音頻 base64
  TTS_STREAM_END: "tts:stream-end",               // main → 渲染端：流式結束（含 cacheKey）
  TTS_STREAM_ERROR: "tts:stream-error",           // main → 渲染端：流式錯誤
  TTS_SAVE_SETTINGS: "tts:save-settings",   // 保存 TTS 配置
  TTS_LOAD_SETTINGS: "tts:load-settings",   // 加載 TTS 配置
  TTS_PICK_AUDIO: "tts:pick-audio",         // 選擇音頻文件（dialog）
  TTS_SYNTHESIZE_GPTSOVITS: "tts:synthesize-gptsovits",             // GPT-SoVITS 合成 → base64
  TTS_SYNTHESIZE_CACHED_GPTSOVITS: "tts:synthesize-cached-gptsovits", // GPT-SoVITS 合成 + 本地緩存
  TTS_SYNTHESIZE_CUSTOM_CLOUD: "tts:synthesize-custom-cloud",             // 自定義雲端 TTS 合成 → base64
  TTS_SYNTHESIZE_CACHED_CUSTOM_CLOUD: "tts:synthesize-cached-custom-cloud", // 自定義雲端 TTS 合成 + 本地緩存
  TTS_SYNTHESIZE_MIMO: "tts:synthesize-mimo",             // 小米 MiMo TTS 合成 → base64
  TTS_SYNTHESIZE_CACHED_MIMO: "tts:synthesize-cached-mimo", // 小米 MiMo TTS 合成 + 本地緩存

  // agent permission level (file/shell access)
  PERMISSION_GET_LEVEL: "permission:get-level",
  PERMISSION_SET_LEVEL: "permission:set-level",
  // main → renderer：要求審批
  PERMISSION_APPROVAL_REQUEST: "permission:approval-request",
  // renderer → main：審批結果回傳
  PERMISSION_APPROVAL_RESOLVE: "permission:approval-resolve",

  // user choice card (ambiguity resolver)
  // 卡片展示走 AGUI_EVENT 的 CUSTOM 事件（與天氣卡片同通道）
  // renderer → main：回傳用戶選擇
  CHOICE_RESOLVE: "choice:resolve",

  // call window (voice call)
  CALL_OPEN: "call:open",                 // sidebar → main：打開通話窗口
  CALL_START: "call:start",               // renderer → main：開始通話（初始化 ASR）
  CALL_AUDIO_FRAME: "call:audio-frame",    // renderer → main：PCM 音頻幀
  CALL_SCREEN_FRAME: "call:screen-frame",  // renderer → main：分享畫面的最新 JPEG/PNG 幀
  CALL_ASR_RESULT: "call:asr-result",     // main → renderer：ASR 識別結果
  CALL_TURN_END: "call:turn-end",         // renderer → main：VAD 靜默，結束本輪
  CALL_TTS_AUDIO: "call:tts-audio",       // main → renderer：TTS 音頻（base64 + format）
  CALL_TTS_DONE: "call:tts-done",         // renderer → main：TTS 播放完畢
  CALL_STATE: "call:state",               // main → renderer：狀態變更
  CALL_ERROR: "call:error",               // main → renderer：錯誤
  CALL_STOP: "call:stop",                 // renderer → main：掛斷

  // 多渠道（Phase 0 骨架，Phase 1+ 實裝微信/飛書）
  CHANNELS_GET_CONFIG: "channels:get-config",
  CHANNELS_SAVE_CONFIG: "channels:save-config",
  CHANNELS_LIST: "channels:list",
  CHANNELS_RESTART: "channels:restart",
  CHANNELS_GET_STATUS: "channels:get-status",
  CHANNELS_INSTALL_PROGRESS: "channels:install-progress",     // main → renderer
  CHANNELS_STATUS_CHANGED: "channels:status-changed",         // main → renderer
  // 微信專屬
  CHANNELS_WECHAT_INSTALL: "channels:wechat:install",
  CHANNELS_WECHAT_LOGIN_START: "channels:wechat:login-start",
  CHANNELS_WECHAT_LOGIN_CANCEL: "channels:wechat:login-cancel",
  CHANNELS_WECHAT_QRCODE: "channels:wechat:qrcode",        // main → renderer, payload: dataURL string
  CHANNELS_WECHAT_LOGIN_DONE: "channels:wechat:login-done", // main → renderer, payload: { ok, botId?, error? }
  CHANNELS_WECHAT_LOGIN_RESULT: "channels:wechat:login-result",
  CHANNELS_WECHAT_PAIRING_LIST: "channels:wechat:pairing-list",
  CHANNELS_WECHAT_PAIRING_APPROVE: "channels:wechat:pairing-approve",
  CHANNELS_WECHAT_LOGOUT: "channels:wechat:logout",
  CHANNELS_WECHAT_RUNTIME_DETECT: "channels:wechat:runtime-detect",
  CHANNELS_WECHAT_RUNTIME_INSTALL: "channels:wechat:runtime-install",
  CHANNELS_WECHAT_RUNTIME_UPDATE: "channels:wechat:runtime-update",
  // 飛書專屬
  CHANNELS_FEISHU_TEST_CONNECTION: "channels:feishu:test-connection",
  CHANNELS_FEISHU_TEST_WEBHOOK_REACHABLE: "channels:feishu:test-webhook-reachable",
  // Discord 專屬
  CHANNELS_DISCORD_TEST_CONNECTION: "channels:discord:test-connection",
  CHANNELS_DISCORD_GET_PROFILE: "channels:discord:get-profile",
  CHANNELS_DISCORD_GET_MUSIC_STATE: "channels:discord:get-music-state",
  CHANNELS_DISCORD_GET_MUSIC_HISTORY: "channels:discord:get-music-history",
  CHANNELS_DISCORD_GET_MUSIC_FAVORITES: "channels:discord:get-music-favorites",
  CHANNELS_DISCORD_CONTROL_MUSIC: "channels:discord:control-music",
  CHANNELS_DISCORD_UPDATE_PROFILE: "channels:discord:update-profile",
  CHANNELS_DISCORD_PICK_AVATAR: "channels:discord:pick-avatar",
  CHANNELS_DISCORD_PICK_BANNER: "channels:discord:pick-banner",
  // Spotify Premium / Connect
  CHANNELS_SPOTIFY_AUTHORIZE: "channels:spotify:authorize",
  CHANNELS_SPOTIFY_GET_STATUS: "channels:spotify:get-status",
  CHANNELS_SPOTIFY_CONTROL: "channels:spotify:control",
  CHANNELS_SPOTIFY_DISCONNECT: "channels:spotify:disconnect",
  // Bilibili / Opera GX browser session
  CHANNELS_BILIBILI_CONNECT: "channels:bilibili:connect",
  CHANNELS_BILIBILI_GET_STATUS: "channels:bilibili:get-status",
  CHANNELS_BILIBILI_DISCONNECT: "channels:bilibili:disconnect",
  // Phase 3.4：消息日誌
  CHANNELS_LOG_GET: "channels:log:get",
  CHANNELS_LOG_CLEAR: "channels:log:clear",
} as const;
