import { BrowserWindow, shell } from "electron";
import { isDev } from "../env";

/**
 * 处理外部 URL：非 http(s) 拒绝，开发环境 localhost:5173 也拒绝（避免调试时误开）。
 * 返回 true 表示已拦截并转交给系统浏览器。
 */
export function openExternalUrl(url: string): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (isDev && url.startsWith("http://localhost:5173")) return false;
  void shell.openExternal(url);
  return true;
}

/**
 * 为 BrowserWindow 挂载外链拦截：
 *  - setWindowOpenHandler：拦截新窗口/外部链接
 *  - will-navigate：拦截页面内导航
 */
export function attachExternalLinkHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    return openExternalUrl(url) ? { action: "deny" } : { action: "allow" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (openExternalUrl(url)) {
      event.preventDefault();
    }
  });
}
