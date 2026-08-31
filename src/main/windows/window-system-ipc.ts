import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { clearUsage, getUsageReport } from "../token-usage-store";
import {
  sidebarWindow,
  tasksWindow,
  settingsWindow,
  musicPlayerWindow,
} from "./window-state";
import type { WindowManager } from "./window-manager";

export interface WindowSystemIpcDependencies {
  get windowManager(): WindowManager | null;
}

/**
 * 注册窗口控制与系统入口相关的 IPC handler。
 *
 * 注意：TOKEN_USAGE_GET 本质属于用量统计领域，当前仅因改动最小而临时
 * 挂靠在此；后续拆分统计模块时应二次归位。
 */
export function registerWindowSystemIpc(deps: WindowSystemIpcDependencies): void {
  ipcMain.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
    deps.windowManager?.setMainWindowInteractive(interactive);
  });

  ipcMain.on(IPC.WINDOW_MOVE, (_event, dx: number, dy: number) => {
    deps.windowManager?.moveMainWindowRelative(dx, dy);
  });

  ipcMain.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
    deps.windowManager?.moveMainWindowTo(x, y);
  });

  ipcMain.on(IPC.WINDOW_SET_DRAGGING, (_event, isDragging: boolean) => {
    deps.windowManager?.setMainWindowDragging(isDragging);
  });

  ipcMain.handle(IPC.WINDOW_CAPTURE_FRAME, async () => deps.windowManager?.captureMainWindowFrame() ?? null);
  ipcMain.handle(IPC.WINDOW_GET_CURSOR_POSITION, () => deps.windowManager?.getCursorScreenPosition() ?? { x: 0, y: 0 });

  ipcMain.on(IPC.SIDEBAR_MINIMIZE, () => {
    sidebarWindow?.minimize();
  });

  ipcMain.on(IPC.SIDEBAR_CLOSE, () => {
    sidebarWindow?.close();
  });

  // 状态栏窗口置顶 toggle：返回切换后的新状态（true=已置顶）
  ipcMain.handle(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP, () => {
    if (!sidebarWindow) return false;
    const next = !sidebarWindow.isAlwaysOnTop();
    sidebarWindow.setAlwaysOnTop(next, next ? "screen-saver" : "normal");
    return next;
  });

  ipcMain.on(IPC.SIDEBAR_OPEN_TASKS, () => {
    deps.windowManager?.createTasksWindow();
  });

  ipcMain.on(IPC.SIDEBAR_OPEN_SETTINGS, (_event, section?: string) => {
    deps.windowManager?.createSettingsWindow(section);
  });

  ipcMain.on(IPC.SIDEBAR_OPEN_CALL, () => {
    deps.windowManager?.createCallWindow();
  });

  ipcMain.on(IPC.TASKS_MINIMIZE, () => {
    tasksWindow?.minimize();
  });

  ipcMain.on(IPC.TASKS_CLOSE, () => {
    tasksWindow?.close();
  });
  ipcMain.on(IPC.SETTINGS_MINIMIZE, () => {
    settingsWindow?.minimize();
  });

  ipcMain.on(IPC.SETTINGS_CLOSE, () => {
    settingsWindow?.close();
  });

  // 音乐播放器窗口控制
  ipcMain.on(IPC.MUSIC_PLAYER_MINIMIZE, () => {
    musicPlayerWindow?.minimize();
  });
  ipcMain.on(IPC.MUSIC_PLAYER_CLOSE, () => {
    musicPlayerWindow?.close();
  });
  ipcMain.handle(IPC.MUSIC_OPEN_PLAYER, () => {
    deps.windowManager?.createMusicPlayerWindow();
    return true;
  });
  ipcMain.handle(IPC.MUSIC_OPEN_SETTINGS, (_event, section?: string) => {
    deps.windowManager?.createSettingsWindow(section);
    return true;
  });

  ipcMain.on(IPC.SETTINGS_OPEN_CHROME_GPU, async () => {
    const win = new BrowserWindow({ width: 1024, height: 768 });
    win.loadURL("chrome://gpu");
    win.show();
  });

  // Token 用量查询 IPC（临时挂靠，后续归到统计模块）
  ipcMain.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => {
    return getUsageReport(Math.max(1, Math.min(90, Number(days) || 7)));
  });
  ipcMain.handle(IPC.TOKEN_USAGE_CLEAR, () => {
    clearUsage();
  });

  ipcMain.on(IPC.LIVE2D_SPEECH_PREPARE, () => {
    deps.windowManager?.sendToMainWindow(IPC.LIVE2D_SPEECH_PREPARE);
  });
  ipcMain.on(IPC.LIVE2D_MOUTH_START, (_event, payload: { durationMs?: number }) => {
    deps.windowManager?.sendToMainWindow(IPC.LIVE2D_MOUTH_START, { durationMs: Number(payload?.durationMs ?? 0) });
  });
  ipcMain.on(IPC.LIVE2D_MOUTH_STOP, () => {
    deps.windowManager?.sendToMainWindow(IPC.LIVE2D_MOUTH_STOP);
  });
}
