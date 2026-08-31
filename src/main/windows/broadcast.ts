import { BrowserWindow } from "electron";

/**
 * 向所有未销毁的窗口广播 IPC 事件。
 * 同时检查 BrowserWindow 和 webContents 是否已销毁。
 */
export function broadcastToAllWindows(
  channel: string,
  payload: unknown,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue;
    }
    window.webContents.send(channel, payload);
  }
}
