import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { getCapabilityOrOpenAI } from "../orchestrator/vendors";
import { normalizeReasoningPreference } from "../../shared/reasoning";
import { loadModelSettings, saveModelSettings } from "../settings/model-settings";
import { loadVisionConfig } from "../settings/model-settings";
import { describePendingAttachment } from "../rag/file-ingest";
import { processDocumentIndexRequest } from "../rag/document-index-ipc";
import {
  enqueueDocumentIndexJob,
  cancelDocumentIndexJob,
} from "../rag/document-index-queue";
import { retrieveQueuedDocumentChunks } from "../rag/document-index-worker";
import { validateCaptionImagePath, buildImageCaptionPrompt } from "../chat/image-caption";
import { decideImageSendStrategy } from "../chat/image-send-strategy";
import type { WindowManager } from "../windows/window-manager";
import { reactChatSession, reactChatWindow } from "../windows/window-state";

export interface ChatUiIpcDependencies {
  live2dWindowLifecycle: { getDiagnostics(): unknown };
  get windowManager(): WindowManager | null;
}

let activeChatSessionId: string | null = null;

export function getActiveChatSessionId(): string | null {
  return activeChatSessionId;
}

export function registerChatUiIpc(deps: ChatUiIpcDependencies): void {
  const { live2dWindowLifecycle } = deps;
  // 注意：windowManager 不能解构 —— getter 在 initIpcHandlers() 调用时值为 null，
  // 解构会固化该值；必须通过 deps.windowManager 延迟求值。

  ipcMain.handle(IPC.LIVE2D_GET_MAIN_DIAGNOSTICS, () => ({
    window: live2dWindowLifecycle.getDiagnostics(),
  }));

  ipcMain.on(IPC.CHAT_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on(IPC.CHAT_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.on(IPC.CHAT_TOGGLE_MAXIMIZE, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) return;
    if (senderWindow.isMaximized()) {
      senderWindow.unmaximize();
    } else {
      senderWindow.maximize();
    }
  });

  ipcMain.handle(IPC.CHAT_IS_MAXIMIZED, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle(IPC.CHAT_GET_REASONING_STATE, () => {
    const settings = loadModelSettings();
    const cap = getCapabilityOrOpenAI(settings.provider);
    return {
      providerKey: settings.provider,
      providerId: cap.id,
      model: settings.model,
      preference: settings.perProvider?.[settings.provider]?.reasoning,
      thinkingOverride: settings.thinkingOverride,
    };
  });

  ipcMain.handle(IPC.CHAT_SET_REASONING, (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { providerKey?: unknown; preference?: unknown };
    if (typeof p.providerKey !== "string" || typeof p.preference !== "object" || !p.preference) return;
    const current = loadModelSettings();
    if (current.provider !== p.providerKey) return;
    const normalized = normalizeReasoningPreference(p.preference);
    if (!normalized) return;
    saveModelSettings({ reasoning: normalized });
  });

  ipcMain.handle(IPC.CHAT_INGEST_FILES, async (_event, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
    if (list.length === 0) return [];
    try {
      return list.map((filePath) => describePendingAttachment(filePath));
    } catch (err: any) {
      console.error("[Cyrene] ingestFiles ERROR:", err?.message || err);
      return [];
    }
  });

  ipcMain.handle(IPC.CHAT_PROCESS_DOCUMENTS, async (event, payload: unknown) => {
    const filePaths = payload && typeof payload === "object" && Array.isArray((payload as { filePaths?: unknown }).filePaths)
      ? (payload as { filePaths: unknown[] }).filePaths.filter((p): p is string => typeof p === "string")
      : [];
    if (filePaths.length === 0) return [];
    const query = typeof (payload as { query?: unknown }).query === "string"
      ? (payload as { query: string }).query
      : "";
    return processDocumentIndexRequest({
      filePaths,
      query,
      sender: event.sender,
      enqueue: enqueueDocumentIndexJob,
      retrieve: retrieveQueuedDocumentChunks,
    });
  });

  ipcMain.handle(IPC.CHAT_CANCEL_DOCUMENT_INDEX, (_event, payload: unknown) => {
    const jobId = payload && typeof payload === "object" ? (payload as { jobId?: unknown }).jobId : undefined;
    return typeof jobId === "string" && cancelDocumentIndexJob(jobId);
  });

  ipcMain.handle(IPC.CHAT_CAPTION_IMAGE, async (_event, payload: unknown) => {
    const filePath = payload && typeof payload === "object"
      ? (payload as { filePath?: unknown }).filePath
      : undefined;
    const hasAnnotations = payload && typeof payload === "object"
      ? (payload as { hasAnnotations?: unknown }).hasAnnotations === true
      : false;
    const validated = validateCaptionImagePath(filePath);
    if (!validated.ok) return { ok: false, error: validated.error };

    const visionCfg = loadVisionConfig();
    if (!visionCfg) {
      return { ok: false, error: "未配置视觉模型，无法分析图片" };
    }

    try {
      const { captionImage } = await import("../orchestrator/vision-captioner");
      const caption = await captionImage(
        { base64: validated.buffer.toString("base64"), mime: validated.mime },
        buildImageCaptionPrompt(hasAnnotations),
        visionCfg,
      );
      if (caption.startsWith("[错误")) {
        return { ok: false, error: caption };
      }
      return { ok: true, caption };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle(IPC.CHAT_GET_IMAGE_PREVIEW, (_event, payload: unknown) => {
    const filePath = payload && typeof payload === "object"
      ? (payload as { filePath?: unknown }).filePath
      : undefined;
    const validated = validateCaptionImagePath(filePath);
    if (!validated.ok) return { ok: false, error: validated.error };
    return {
      ok: true,
      dataUrl: `data:${validated.mime};base64,${validated.buffer.toString("base64")}`,
    };
  });

  ipcMain.handle(IPC.CHAT_GET_IMAGE_SEND_STRATEGY, () => {
    const settings = loadModelSettings();
    return decideImageSendStrategy({
      multimodal: settings.multimodal,
      vision: loadVisionConfig(),
    });
  });

  // 状态栏专用入口：打开/复用 reactChatWindow
  ipcMain.handle(IPC.CHATS_OPEN_IN_REACT_WINDOW, (_event, sessionId: string) => {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) return false;
    deps.windowManager?.createReactChatWindow(sessionId);
    return true;
  });

  // reactChatWindow → main：声明 ChatPage 已挂好 IPC 监听
  ipcMain.on(IPC.CHATS_REACT_READY, (event) => {
    const win = reactChatWindow;
    if (!win || win.isDestroyed()) return;
    if (event.sender !== win.webContents) return;
    const pending = reactChatSession.markReady();
    if (pending) {
      win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, pending);
    }
  });

  // 聊天窗口启动/切换会话时上报当前活跃 sessionId；main 广播给所有窗口
  ipcMain.handle(IPC.CHATS_SET_ACTIVE_SESSION, (_event, sessionId: string | null) => {
    activeChatSessionId = sessionId ?? null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(IPC.CHATS_ACTIVE_SESSION_CHANGED, activeChatSessionId); } catch { /* ignore */ }
    }
    return true;
  });

  ipcMain.handle(IPC.CHATS_GET_ACTIVE_SESSION, () => activeChatSessionId);
}
