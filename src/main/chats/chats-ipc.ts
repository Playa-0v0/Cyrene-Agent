// 聊天会话 IPC 桥接：把 chats-store 的纯数据 API 暴露给渲染进程。
//
// 写操作成功后会向渲染窗口广播 `chats:changed`，以便：
// - 设置中心 💬聊天面板刷新列表；
// - 聊天窗口在标题被改名等情况下同步显示。
//
// 来源隔离：渲染进程发起的写操作广播时会跳过发起方窗口（sender）--发起方已经
// 持有最新状态，不需要被自己的写唤醒；只让其它窗口（以及"外部主动消息提交"这种
// 主进程发起的写）触发的广播到达聊天窗口。这样聊天窗口的 onChanged 只会因真正的
// 外部变更触发，避免本窗口 saveSession() 的广播回来重载当前会话、清掉 transient
// 思考消息的竞态。
//
// 注意：`chats:open-in-chat-window` 涉及 BrowserWindow 创建逻辑，
// 由 src/main/index.ts 自行注册，不在本模块；本模块只管纯数据操作。

import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ChatMessage } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";

function broadcastChanged(senderWebContents?: WebContents | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // 跳过发起方：渲染进程自己的写不需要广播回自己（来源隔离）。
    if (senderWebContents && win.webContents === senderWebContents) continue;
    try {
      win.webContents.send(IPC.CHATS_CHANGED);
    } catch {
      // 某些刚创建/未 ready 的窗口 send 可能抛错，忽略即可
    }
  }
}

export function registerChatsIpc(): void {
  chatsStore.initialize();

  ipcMain.handle(IPC.CHATS_LIST, () => chatsStore.listSessions());

  ipcMain.handle(IPC.CHATS_GET, (_event, id: string) => chatsStore.getSession(id));
  ipcMain.handle(IPC.CHATS_GET_PAGE, (_event, payload: { id: string; before?: number | null; limit?: number }) => {
    if (!payload?.id) return null;
    return chatsStore.getSessionPage(payload.id, payload.before ?? null, payload.limit ?? 80);
  });

  ipcMain.handle(
    IPC.CHATS_CREATE,
    (
      event,
      payload?: { title?: string; identityId?: string | null },
    ) => {
      const session = chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
      });
      broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_APPEND,
    (event, payload: { id: string; message: ChatMessage }) => {
      if (!payload || !payload.id || !payload.message) return null;
      const session = chatsStore.appendMessage(payload.id, payload.message);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_REPLACE_MESSAGES,
    (event, payload: { id: string; messages: ChatMessage[] }) => {
      if (!payload || !payload.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessages(payload.id, payload.messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );
  ipcMain.handle(
    IPC.CHATS_REPLACE_TAIL,
    (event, payload: { id: string; startIndex: number; messages: ChatMessage[] }) => {
      if (!payload?.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessagesTail(payload.id, payload.startIndex, payload.messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(
    IPC.CHATS_RENAME,
    (event, payload: { id: string; title: string }) => {
      if (!payload || !payload.id) return null;
      const session = chatsStore.renameSession(payload.id, payload.title ?? "");
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipcMain.handle(IPC.CHATS_DELETE, (event, id: string) => {
    if (!id) return false;
    const ok = chatsStore.deleteSession(id);
    if (ok) broadcastChanged(event.sender);
    return ok;
  });

  ipcMain.handle(IPC.CHATS_OPEN_FOLDER, async () => {
    await chatsStore.openStorageFolder();
    return true;
  });

  ipcMain.handle(
    IPC.CHATS_MIGRATE_LEGACY,
    (event, messages: ChatMessage[]) => {
      const session = chatsStore.migrateLegacyMessages(messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );
}

// 给 main/index.ts 用的便捷 broadcast（删除当前活跃会话后由 index.ts 调一次；
// 主动消息提交 commitLocalProactiveMessage 也用它）。
// 这些都是主进程发起的写，没有 sender，广播给所有窗口（含聊天窗口）--对聊天窗口
// 而言属于"真正的外部变更"，应当触发重载。
export { broadcastChanged as broadcastChatsChanged };

