// init-channels —— channels 模塊的主入口。由 index.ts 在 app.whenReady() 調一次。
//
// 當前階段：
//   - Phase 0: 骨架 + dispatcher + inbound-server
//   - Phase 2: 接入 FeishuAdapter（自建飛書應用 + 事件訂閱）
//
// 注意：initChannels 必須晚於 initRAG / initMcpManager / loadModelSettings。
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { IPC } from "../../shared/ipc-channels";
import {
  loadChannelsSettings,
  saveChannelsSettings,
} from "./settings-store";
import { channelManager } from "./manager";
import { channelDispatcher } from "./dispatcher";
import { startInboundServer, stopInboundServer } from "./inbound-server";
import { FeishuAdapter } from "./adapters/feishu";
import { ILinkBotAdapter, loadCredentials } from "./adapters/wechat/ilink-bot-adapter";
import { DiscordAdapter } from "./adapters/discord";
import { getRecentLog, clearLog } from "./message-log";
import { loadDiscordMusicHistory } from "./adapters/discord/music-history";
import { loadDiscordMusicFavorites } from "./adapters/discord/music-favorites";
import { controlSpotify, disconnectSpotify, getSpotifyStatus, startSpotifyAuthorization } from "./spotify-control";
import { configureBilibiliBrowserCookies, getOperaGxProfilePath, testBilibiliBrowserCookies } from "./adapters/discord/music-source";

const LOG = "[ChannelsInit]";

let initialized = false;
/** 微信 adapter 全局引用（UI 登錄按鈕需要） */
let wxAdapter: ILinkBotAdapter | null = null;

/** app.whenReady() 調一次。idempotent。 */
export async function initChannels(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // app.whenReady() 後才讀取含 safeStorage 密文的渠道設定。
  channelDispatcher.reloadSettings();
  configureBilibiliBrowserCookies(loadChannelsSettings().bilibili.enabled);

  // 注入 dispatcher 到 manager
  channelManager.setDispatcher(async (msg) => {
    return await channelDispatcher.handleIncoming(msg);
  });

  // 註冊全局 IPC
  registerChannelsIpc();

  // 啟動 inbound-server
  try {
    const handle = await startInboundServer();
    console.log(LOG, `入站 server 監聽 http://127.0.0.1:${handle.port}`);
  } catch (err) {
    console.error(LOG, "入站 server 啟動失敗:", err);
  }

  // 註冊 adapter
  const feishuAdapter = new FeishuAdapter();
  channelManager.register(feishuAdapter);

  const discordAdapter = new DiscordAdapter(async (msg) => await channelManager.dispatchOnly(msg));
  channelManager.register(discordAdapter);

  // 註冊微信 adapter（iLink 直連微信，不依賴 OpenClaw Gateway）
  // 改為 module-level handle，UI 登錄按鈕也能拿到
  wxAdapter = new ILinkBotAdapter();
  channelManager.register(wxAdapter);

  // 啟動所有已註冊 adapter
  await channelManager.startAll();

  console.log(LOG, "channels 模塊就緒");
  broadcastChannelsStatus();
}

/** app.on('before-quit') 調 */
export async function shutdownChannels(): Promise<void> {
  await channelManager.stopAll();
  await stopInboundServer();
  initialized = false;
}

/** IPC 註冊 */
function registerChannelsIpc(): void {
  ipcMain.handle(IPC.CHANNELS_GET_CONFIG, () => loadChannelsSettings());

  ipcMain.handle(IPC.CHANNELS_SAVE_CONFIG, (_e, patch: unknown) => {
    const saved = saveChannelsSettings(patch as Parameters<typeof saveChannelsSettings>[0]);
    channelDispatcher.reloadSettings();
    configureBilibiliBrowserCookies(saved.bilibili.enabled);
    return saved;
  });

  ipcMain.handle(IPC.CHANNELS_LIST, () => channelManager.listChannels());

  ipcMain.handle(IPC.CHANNELS_GET_STATUS, () => channelManager.getAllStatus());

  ipcMain.handle(IPC.CHANNELS_RESTART, async () => {
    await channelManager.stopAll();
    await channelManager.startAll();
    broadcastChannelsStatus();
    return { ok: true };
  });

  // ── 微信 IPC (iLink 直連版) ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.CHANNELS_WECHAT_RUNTIME_DETECT, () => {
    // iLink Bot API 是騰訊的遠程協議，不需本地安裝
    return { installed: true, version: "ilink/1.0.0" };
  });

	  // 掃碼登錄：Main Process 生成 PNG dataURL，推給 Renderer 顯示 <img>
	  ipcMain.handle(IPC.CHANNELS_WECHAT_LOGIN_START, async () => {
	    if (!wxAdapter) return { ok: false, error: "adapter 未初始化" };
	    try {
	      const { fetchQrCode } = await import("./adapters/wechat/ilink-protocol-client");
	      const { createQrDataUrl } = await import("./adapters/wechat/qr");

	      // 1. 拿原始 qrcode 字符串 + liteapp 二維碼 URL
	      //    - qrcode: 32 hex ticket（輪詢 get_qrcode_status 用）
	      //    - qrcode_img_content: liteapp.weixin.qq.com/q/... URL（掃了會拉起 iLink 灰度插件）
	      const { qrcode, qrcode_img_content } = await fetchQrCode();

	      // 2. Main Process 生成 PNG dataURL（用 liteapp URL 而不是裸 ticket，
	      //    否則微信只識別為純文本、不會觸發 iLink 確認流程）
	      const dataUrl = await createQrDataUrl(qrcode_img_content, 256);

	      // 3. 推給 Renderer
	      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	      win?.webContents.send(IPC.CHANNELS_WECHAT_QRCODE, dataUrl);

	      // 4. 後臺輪詢掃碼狀態
	      void (async () => {
	        try {
	          const creds = await wxAdapter!.login(qrcode);
	          await wxAdapter!.stop();
	          await wxAdapter!.start();
	          win?.webContents.send(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: true, botId: creds.ilinkBotId });
	        } catch (err) {
	          win?.webContents.send(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: false, error: String(err) });
	        }
	      })();

	      return { ok: true, hint: "請掃描二維碼" };
	    } catch (err) {
	      return { ok: false, error: String(err) };
	    }
	  });

  ipcMain.handle(IPC.CHANNELS_WECHAT_LOGIN_CANCEL, () => {
    return { ok: true };
  });

  ipcMain.handle(IPC.CHANNELS_WECHAT_LOGIN_RESULT, async () => {
    if (!wxAdapter) return { connected: false };
    const status = wxAdapter.getStatus();
    return {
      running: status.phase === "starting",
      connected: status.phase === "running",
      loggedIn: wxAdapter.isLoggedIn,
    };
  });

  ipcMain.handle(IPC.CHANNELS_WECHAT_PAIRING_LIST, () => {
    // iLink 模式沒有 pairing 概念
    return [];
  });

  ipcMain.handle(IPC.CHANNELS_WECHAT_PAIRING_APPROVE, () => ({ ok: false, error: "iLink 模式不支持 pairing" }));

  ipcMain.handle(IPC.CHANNELS_WECHAT_LOGOUT, async () => {
    if (!wxAdapter) return { ok: false };
    await wxAdapter.logout();
    return { ok: true };
  });

  ipcMain.handle(IPC.CHANNELS_WECHAT_RUNTIME_INSTALL, () => ({
    ok: true,
    hint: "iLink Bot API 是雲端協議，無需本地安裝",
  }));

  ipcMain.handle(IPC.CHANNELS_WECHAT_RUNTIME_UPDATE, () => ({ ok: true }));

  ipcMain.handle(IPC.CHANNELS_WECHAT_INSTALL, async () => {
    if (!wxAdapter) return { ok: false };
    await wxAdapter.stop();
    await wxAdapter.start();
    return { ok: true, phase: "ready" };
  });

  // Phase 2 長連接：測試連接 = 重建 LarkChannel（SDK 內部會自動跑 WSS handshake）
  ipcMain.handle(IPC.CHANNELS_FEISHU_TEST_CONNECTION, async () => {
    const adapter = channelManager.getAdapter("feishu") as FeishuAdapter | undefined;
    if (!adapter) return { ok: false, error: "飛書 adapter 未註冊" };
    const status = adapter.getStatus();
    if (!status.enabled) return { ok: false, error: "飛書渠道未啟用" };
    if (!loadChannelsSettings().feishu.appId || !loadChannelsSettings().feishu.appSecret) {
      return { ok: false, error: "App ID / App Secret 未配置" };
    }
    try {
      await adapter.rebuild();
      const s = adapter.getStatus();
      if (s.phase === "running") {
        return { ok: true, message: "WSS 長連接已建立" };
      }
      return { ok: false, error: s.message ?? "握手未完成" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 長連接模式不需要 webhook URL —— 這個 IPC 保留但返回 ok 提示用戶用長連接
  ipcMain.handle(IPC.CHANNELS_FEISHU_TEST_WEBHOOK_REACHABLE, async () => {
    return {
      ok: true,
      message: "長連接模式不需要公網 URL — SDK 已自動建立 WSS 連接",
    };
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_TEST_CONNECTION, async () => {
    const adapter = channelManager.getAdapter("discord") as DiscordAdapter | undefined;
    if (!adapter) return { ok: false, error: "Discord adapter 未註冊" };
    try {
      await adapter.rebuild();
      const status = adapter.getStatus();
      broadcastChannelsStatus();
      if (!status.enabled && status.phase === "offline") {
        return { ok: true, message: "Discord 已停止連線" };
      }
      return status.phase === "running"
        ? { ok: true, message: status.message ?? "Discord Gateway 已連接" }
        : { ok: false, error: status.message ?? "連接失敗" };
    } catch (err) {
      broadcastChannelsStatus();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_GET_PROFILE, () => {
    const adapter = channelManager.getAdapter("discord") as DiscordAdapter | undefined;
    return adapter?.getProfile() ?? { connected: false, guildCount: 0, guilds: [], voiceActive: false };
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_GET_MUSIC_STATE, () => {
    const adapter = channelManager.getAdapter("discord") as DiscordAdapter | undefined;
    return adapter?.getMusicState() ?? { active: false, paused: false, current: null, queue: [], volume: 100, repeat: "off", shuffle: false, autoplay: false, elapsed: 0 };
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_GET_MUSIC_HISTORY, () => loadDiscordMusicHistory(50));
  ipcMain.handle(IPC.CHANNELS_DISCORD_GET_MUSIC_FAVORITES, () => loadDiscordMusicFavorites(500));

  ipcMain.handle(IPC.CHANNELS_DISCORD_CONTROL_MUSIC, async (_event, raw: unknown) => {
    const adapter = channelManager.getAdapter("discord") as DiscordAdapter | undefined;
    if (!adapter) return { ok: false, message: "Discord adapter 未註冊" };
    const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const allowed = new Set(["previous", "pause", "resume", "skip", "stop", "repeat-track", "repeat-queue", "repeat-off", "shuffle", "ordered", "autoplay-on", "autoplay-off", "clear", "remove", "volume"]);
    if (typeof input.command !== "string" || !allowed.has(input.command)) return { ok: false, message: "不支援的播放控制" };
    return await adapter.controlMusic({
      command: input.command as Parameters<DiscordAdapter["controlMusic"]>[0]["command"],
      value: typeof input.value === "number" ? input.value : undefined,
    });
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_PICK_AVATAR, async () => {
    const result = await dialog.showOpenDialog({
      title: "選擇 Discord Bot 頭像",
      properties: ["openFile"],
      filters: [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_PICK_BANNER, async () => {
    const result = await dialog.showOpenDialog({
      title: "選擇 Discord Bot Banner",
      properties: ["openFile"],
      filters: [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.CHANNELS_DISCORD_UPDATE_PROFILE, async (_event, raw: unknown) => {
    const adapter = channelManager.getAdapter("discord") as DiscordAdapter | undefined;
    if (!adapter) return { ok: false, error: "Discord adapter 未註冊" };
    const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    try {
      let avatar: Buffer | undefined;
      let banner: Buffer | undefined;
      if (typeof input.avatarPath === "string" && input.avatarPath) {
        const fileInfo = await stat(input.avatarPath);
        if (fileInfo.size > 8 * 1024 * 1024) throw new Error("頭像檔案不可超過 8 MB");
        avatar = await readFile(input.avatarPath);
      }
      if (typeof input.bannerPath === "string" && input.bannerPath) {
        const fileInfo = await stat(input.bannerPath);
        if (fileInfo.size > 10 * 1024 * 1024) throw new Error("Banner 檔案不可超過 10 MB");
        banner = await readFile(input.bannerPath);
      }
      const allowedStatuses = new Set(["online", "idle", "dnd", "invisible"]);
      const status = typeof input.status === "string" && allowedStatuses.has(input.status)
        ? input.status as "online" | "idle" | "dnd" | "invisible"
        : undefined;
      const profile = await adapter.updateProfile({
        username: typeof input.username === "string" ? input.username : undefined,
        activityText: typeof input.activityText === "string" ? input.activityText : undefined,
        status,
        avatar,
        banner,
      });
      return { ok: true, profile };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.CHANNELS_SPOTIFY_AUTHORIZE, async (_event, raw: unknown) => {
    const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return await startSpotifyAuthorization({
      clientId: typeof input.clientId === "string" ? input.clientId : undefined,
      clientSecret: typeof input.clientSecret === "string" ? input.clientSecret : undefined,
    });
  });
  ipcMain.handle(IPC.CHANNELS_SPOTIFY_GET_STATUS, () => getSpotifyStatus());
  ipcMain.handle(IPC.CHANNELS_SPOTIFY_CONTROL, async (_event, raw: unknown) => {
    const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return await controlSpotify({
      command: typeof input.command === "string" ? input.command : undefined,
      value: typeof input.value === "number" ? input.value : undefined,
      deviceId: typeof input.deviceId === "string" ? input.deviceId : undefined,
      query: typeof input.query === "string" ? input.query : undefined,
    });
  });
  ipcMain.handle(IPC.CHANNELS_SPOTIFY_DISCONNECT, () => {
    disconnectSpotify();
    return { ok: true, message: "Spotify 已解除連線" };
  });

  ipcMain.handle(IPC.CHANNELS_BILIBILI_GET_STATUS, () => {
    const config = loadChannelsSettings().bilibili;
    return {
      connected: config.enabled,
      browser: "Opera GX",
      profilePath: getOperaGxProfilePath(),
    };
  });
  ipcMain.handle(IPC.CHANNELS_BILIBILI_CONNECT, async () => {
    try {
      const verified = await testBilibiliBrowserCookies();
      saveChannelsSettings({ bilibili: { enabled: true, browser: "opera-gx" } });
      configureBilibiliBrowserCookies(true);
      return { ok: true, message: `已連接 Opera GX 的 Bilibili 登入狀態`, ...verified };
    } catch (error) {
      configureBilibiliBrowserCookies(false);
      saveChannelsSettings({ bilibili: { enabled: false, browser: "opera-gx" } });
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `無法讀取 Opera GX 的 Bilibili 登入狀態：${detail}` };
    }
  });
  ipcMain.handle(IPC.CHANNELS_BILIBILI_DISCONNECT, () => {
    configureBilibiliBrowserCookies(false);
    saveChannelsSettings({ bilibili: { enabled: false, browser: "opera-gx" } });
    return { ok: true, message: "Bilibili 已解除連接；Opera GX 登入不受影響" };
  });

  // Phase 3.4：消息日誌
  ipcMain.handle(IPC.CHANNELS_LOG_GET, (_e, limit: unknown) => {
    const n = typeof limit === "number" && limit > 0 ? limit : 100;
    return getRecentLog(n);
  });
  ipcMain.handle(IPC.CHANNELS_LOG_CLEAR, () => {
    clearLog();
    return { ok: true };
  });
}

/** 工具：把所有 BrowserWindow 廣播 channels 狀態變更（UI 輪詢用）。 */
export function broadcastChannelsStatus(): void {
  const status = channelManager.getAllStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.CHANNELS_STATUS_CHANGED, status);
    } catch (err) {
      console.warn(LOG, "廣播失敗:", err);
    }
  }
}

/** 工具：把所有 BrowserWindow 廣播安裝進度。 */
export function broadcastChannelsInstallProgress(progress: {
  channel: string;
  phase: string;
  pct: number;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.CHANNELS_INSTALL_PROGRESS, progress);
    } catch (err) {
      console.warn(LOG, "廣播安裝進度失敗:", err);
    }
  }
}
