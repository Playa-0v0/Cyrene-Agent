import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";

/** 桌宠窗口的基础尺寸（zoom=1.0 时）。缩放因子改变窗口与模型尺寸，二者同步。 */
export const PET_WINDOW_BASE_WIDTH = 400;
export const PET_WINDOW_BASE_HEIGHT = 500;

/**
 * 仅创建阶段需要的 GeneralSettings 切片。
 * 避免反向依赖 index.ts 中的完整 loadGeneralSettings。
 */
export interface MainWindowSettingsSlice {
  petWindowX?: number;
  petWindowY?: number;
}

export interface CreateMainWindowContext {
  loadGeneralSettings: () => MainWindowSettingsSlice;
  getCurrentAppIconPath: () => string;
  isDev: boolean;
}

/**
 * 创建主桌宠窗口。
 * 只负责机械构造：恢复上次坐标、创建 BrowserWindow、加载 URL/文件、
 * 绑定 show/hide 可见性广播。不含业务 getter 注入。
 */
export function createMainWindow(ctx: CreateMainWindowContext): BrowserWindow {
  const settings = ctx.loadGeneralSettings();
  const transparent = true;
  let restoreX: number | undefined;
  let restoreY: number | undefined;

  if (settings.petWindowX !== undefined && settings.petWindowY !== undefined) {
    const PET_W = PET_WINDOW_BASE_WIDTH;
    const PET_H = PET_WINDOW_BASE_HEIGHT;
    const targetBounds = {
      x: settings.petWindowX,
      y: settings.petWindowY,
      width: PET_W,
      height: PET_H,
    };
    const display = screen.getDisplayMatching(targetBounds);
    const wa = display.workArea;

    // 窗口与 workArea 交集至少 80x80 才使用保存的坐标
    const interW =
      Math.min(targetBounds.x + PET_W, wa.x + wa.width) -
      Math.max(targetBounds.x, wa.x);
    const interH =
      Math.min(targetBounds.y + PET_H, wa.y + wa.height) -
      Math.max(targetBounds.y, wa.y);

    if (interW >= 80 && interH >= 80) {
      restoreX = settings.petWindowX;
      restoreY = settings.petWindowY;
    } else {
      console.log(
        "[Cyrene] 桌宠保存位置已离屏（仅 " +
          interW + "x" + interH + " 可见），使用默认位置",
      );
    }
  }

  const win = new BrowserWindow({
    x: restoreX,
    y: restoreY,
    width: PET_WINDOW_BASE_WIDTH,
    height: PET_WINDOW_BASE_HEIGHT,
    transparent,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    icon: ctx.getCurrentAppIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (ctx.isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "..", "..", "renderer", "index.html"));
  }

  if (!ctx.isDev) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  win.on("hide", () => {
    win.webContents.send(IPC.PET_VISIBILITY_CHANGED, false);
  });
  win.on("show", () => {
    win.webContents.send(IPC.PET_VISIBILITY_CHANGED, true);
  });

  return win;
}
