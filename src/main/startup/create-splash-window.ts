import { app, BrowserWindow, screen } from "electron";
import path from "node:path";

export interface CreateSplashWindowContext {
  isDev: boolean;
}

const SPLASH_SIZE = 520;

export function createSplashWindow(ctx: CreateSplashWindowContext): BrowserWindow {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const window = new BrowserWindow({
    width: SPLASH_SIZE,
    height: SPLASH_SIZE,
    x: Math.round((screenWidth - SPLASH_SIZE) / 2),
    y: Math.round((screenHeight - SPLASH_SIZE) / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      // 闪屏窗口不需要 Node/IPC 访问
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  window.setIgnoreMouseEvents(true);

  if (ctx.isDev) {
    // Vite dev server 会把 public 目录下的文件挂在根路径
    window.loadURL("http://localhost:5173/splash.html").catch((err) => {
      console.error("[Splash] Failed to load dev URL:", err);
    });
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "splash.html")).catch((err) => {
      console.error("[Splash] Failed to load splash.html:", err);
    });
  }

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });

  return window;
}
