// init-channels —— channels 模块的主入口。由 index.ts 在 app.whenReady() 调一次。
//
// 当前阶段：
//   - Phase 0: 骨架 + dispatcher + inbound-server
//   - Phase 2: 接入 FeishuAdapter（自建飞书应用 + 事件订阅）
//
// 注意：initChannels 必须晚于 initRAG / initMcpManager / loadModelSettings。
import { app, BrowserWindow, ipcMain } from "electron";
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
import { NapCatAdapter } from "./adapters/qq/napcat-adapter";
import { QqBotAdapter } from "./adapters/qqbot/qqbot-adapter";
import { getRecentLog, clearLog } from "./message-log";
import { logger, LogTag } from "../logger";

const LOG = "[ChannelsInit]";

let initialized = false;
let conversationLifecycle: {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
} | null = null;

export function setChannelsConversationLifecycle(lifecycle: typeof conversationLifecycle): void {
  conversationLifecycle = lifecycle;
}
/** 微信 adapter 全局引用（UI 登录按钮需要） */
let wxAdapter: ILinkBotAdapter | null = null;
let qqAdapter: NapCatAdapter | null = null;
let qqBotAdapter: QqBotAdapter | null = null;

function getPublicChannelsSettings(): Record<string, unknown> {
  const settings = loadChannelsSettings();
  return {
    ...settings,
    qq: {
      ...settings.qq,
      accessToken: undefined,
      hasAccessToken: Boolean(settings.qq.accessToken),
    },
    qqbot: {
      ...settings.qqbot,
      appSecret: undefined,
      hasAppSecret: Boolean(settings.qqbot.appSecret),
    },
  };
}

/** app.whenReady() 调一次。idempotent。 */
export async function initChannels(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 注入 dispatcher 到 manager
  channelManager.setDispatcher(async (msg) => {
    conversationLifecycle?.onUserMessage();
    conversationLifecycle?.onConversationStarted();
    try {
      return await channelDispatcher.handleIncoming(msg);
    } finally {
      conversationLifecycle?.onConversationEnded();
    }
  });

  // 注册全局 IPC
  registerChannelsIpc();

  // 启动 inbound-server
  try {
    const handle = await startInboundServer();
    logger.info(LogTag.InboundServer, `listening on http://127.0.0.1:${handle.port}`);
  } catch (err) {
    console.error(LOG, "入站 server 启动失败:", err);
  }

  // 注册 adapter
  const feishuAdapter = new FeishuAdapter();
  channelManager.register(feishuAdapter);

  // 注册微信 adapter（iLink 直连微信，不依赖 OpenClaw Gateway）
  // 改为 module-level handle，UI 登录按钮也能拿到
  wxAdapter = new ILinkBotAdapter();
  channelManager.register(wxAdapter);

  qqAdapter = new NapCatAdapter(broadcastChannelsStatus);
  channelManager.register(qqAdapter);

  // 注册 QQ 官方机器人 adapter（QQ 开放平台 API v2，AppID/AppSecret + WebSocket 网关）
  qqBotAdapter = new QqBotAdapter(broadcastChannelsStatus);
  channelManager.register(qqBotAdapter);

  // 启动所有已注册 adapter
  await channelManager.startAll();

  logger.info(LogTag.Channels, "channels module ready");
  broadcastChannelsStatus();
}

/** app.on('before-quit') 调 */
export async function shutdownChannels(): Promise<void> {
  await channelManager.stopAll();
  await stopInboundServer();
  initialized = false;
}

/** IPC 注册 */
function registerChannelsIpc(): void {
  ipcMain.handle(IPC.CHANNELS_GET_CONFIG, () => getPublicChannelsSettings());

  ipcMain.handle(IPC.CHANNELS_SAVE_CONFIG, (_e, patch: unknown) => {
    saveChannelsSettings(patch as Parameters<typeof saveChannelsSettings>[0]);
    channelDispatcher.reloadSettings();
    return getPublicChannelsSettings();
  });

  ipcMain.handle(IPC.CHANNELS_LIST, () => channelManager.listChannels());

  ipcMain.handle(IPC.CHANNELS_GET_STATUS, () => channelManager.getAllStatus());

  ipcMain.handle(IPC.CHANNELS_RESTART, async () => {
    await channelManager.stopAll();
    await channelManager.startAll();
    broadcastChannelsStatus();
    return { ok: true };
  });

  // ── 微信 IPC (iLink 直连版) ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.CHANNELS_WECHAT_RUNTIME_DETECT, () => {
    // iLink Bot API 是腾讯的远程协议，不需本地安装
    return { installed: true, version: "ilink/1.0.0" };
  });

	  // 扫码登录：Main Process 生成 PNG dataURL，推给 Renderer 显示 <img>
	  ipcMain.handle(IPC.CHANNELS_WECHAT_LOGIN_START, async () => {
	    if (!wxAdapter) return { ok: false, error: "adapter 未初始化" };
	    try {
	      const { fetchQrCode } = await import("./adapters/wechat/ilink-protocol-client");
	      const { createQrDataUrl } = await import("./adapters/wechat/qr");

	      // 1. 拿原始 qrcode 字符串 + liteapp 二维码 URL
	      //    - qrcode: 32 hex ticket（轮询 get_qrcode_status 用）
	      //    - qrcode_img_content: liteapp.weixin.qq.com/q/... URL（扫了会拉起 iLink 灰度插件）
	      const { qrcode, qrcode_img_content } = await fetchQrCode();

	      // 2. Main Process 生成 PNG dataURL（用 liteapp URL 而不是裸 ticket，
	      //    否则微信只识别为纯文本、不会触发 iLink 确认流程）
	      const dataUrl = await createQrDataUrl(qrcode_img_content, 256);

	      // 3. 推给 Renderer
	      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	      win?.webContents.send(IPC.CHANNELS_WECHAT_QRCODE, dataUrl);

	      // 4. 后台轮询扫码状态
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

	      return { ok: true, hint: "请扫描二维码" };
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
    // iLink 模式没有 pairing 概念
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
    hint: "iLink Bot API 是云端协议，无需本地安装",
  }));

  ipcMain.handle(IPC.CHANNELS_WECHAT_RUNTIME_UPDATE, () => ({ ok: true }));

  ipcMain.handle(IPC.CHANNELS_WECHAT_INSTALL, async () => {
    if (!wxAdapter) return { ok: false };
    await wxAdapter.stop();
    await wxAdapter.start();
    return { ok: true, phase: "ready" };
  });

  // Phase 2 长连接：测试连接 = 重建 LarkChannel（SDK 内部会自动跑 WSS handshake）
  ipcMain.handle(IPC.CHANNELS_FEISHU_TEST_CONNECTION, async () => {
    const adapter = channelManager.getAdapter("feishu") as FeishuAdapter | undefined;
    if (!adapter) return { ok: false, error: "飞书 adapter 未注册" };
    const status = adapter.getStatus();
    if (!status.enabled) return { ok: false, error: "飞书渠道未启用" };
    if (!loadChannelsSettings().feishu.appId || !loadChannelsSettings().feishu.appSecret) {
      return { ok: false, error: "App ID / App Secret 未配置" };
    }
    try {
      await adapter.rebuild();
      const s = adapter.getStatus();
      if (s.phase === "running") {
        return { ok: true, message: "WSS 长连接已建立" };
      }
      return { ok: false, error: s.message ?? "握手未完成" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 长连接模式不需要 webhook URL —— 这个 IPC 保留但返回 ok 提示用户用长连接
  ipcMain.handle(IPC.CHANNELS_FEISHU_TEST_WEBHOOK_REACHABLE, async () => {
    return {
      ok: true,
      message: "长连接模式不需要公网 URL — SDK 已自动建立 WSS 连接",
    };
  });

  ipcMain.handle(IPC.CHANNELS_QQ_TEST_CONNECTION, async () => {
    if (!qqAdapter) return { ok: false, error: "QQ adapter 未初始化" };
    return await qqAdapter.testConnection();
  });

  // ── QQ 官方机器人 IPC ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.CHANNELS_QQBOT_TEST_CONNECTION, async () => {
    if (!qqBotAdapter) return { ok: false, error: "QQ Bot adapter 未初始化" };
    return await qqBotAdapter.testConnection();
  });

  // Phase 3.4：消息日志
  ipcMain.handle(IPC.CHANNELS_LOG_GET, (_e, limit: unknown) => {
    const n = typeof limit === "number" && limit > 0 ? limit : 100;
    return getRecentLog(n);
  });
  ipcMain.handle(IPC.CHANNELS_LOG_CLEAR, () => {
    clearLog();
    return { ok: true };
  });
}

/** 工具：把所有 BrowserWindow 广播 channels 状态变更（UI 轮询用）。 */
export function broadcastChannelsStatus(): void {
  const status = channelManager.getAllStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.CHANNELS_STATUS_CHANGED, status);
    } catch (err) {
      console.warn(LOG, "广播失败:", err);
    }
  }
}

/** 工具：把所有 BrowserWindow 广播安装进度。 */
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
      console.warn(LOG, "广播安装进度失败:", err);
    }
  }
}
