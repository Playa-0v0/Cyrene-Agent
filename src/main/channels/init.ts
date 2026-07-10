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
import { QqNapCatAdapter } from "./adapters/qq-napcat";
import { getRecentLog, clearLog } from "./message-log";

const LOG = "[ChannelsInit]";

let initialized = false;
/** 微信 adapter 全局引用（UI 登录按钮需要） */
let wxAdapter: ILinkBotAdapter | null = null;

/** app.whenReady() 调一次。idempotent。 */
export async function initChannels(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 注入 dispatcher 到 manager
  channelManager.setDispatcher(async (msg) => {
    return await channelDispatcher.handleIncoming(msg);
  });

  // 注册全局 IPC
  registerChannelsIpc();

  // 启动 inbound-server
  try {
    const handle = await startInboundServer();
    console.log(LOG, `入站 server 监听 http://127.0.0.1:${handle.port}`);
  } catch (err) {
    console.error(LOG, "入站 server 启动失败:", err);
  }

  // 注册 adapter
  const feishuAdapter = new FeishuAdapter();
  channelManager.register(feishuAdapter);

  const qqAdapter = new QqNapCatAdapter();
  channelManager.register(qqAdapter);

  // 注册微信 adapter（iLink 直连微信，不依赖 OpenClaw Gateway）
  // 改为 module-level handle，UI 登录按钮也能拿到
  wxAdapter = new ILinkBotAdapter();
  channelManager.register(wxAdapter);

  // 启动所有已注册 adapter
  await channelManager.startAll();

  console.log(LOG, "channels 模块就绪");
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
  ipcMain.handle(IPC.CHANNELS_GET_CONFIG, () => loadChannelsSettings());

  ipcMain.handle(IPC.CHANNELS_SAVE_CONFIG, (_e, patch: unknown) => {
    return saveChannelsSettings(patch as Parameters<typeof saveChannelsSettings>[0]);
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
