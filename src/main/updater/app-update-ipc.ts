import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { AppUpdateState } from "../../shared/app-update";
import type { AppUpdateService } from "./app-update-service";

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: AppUpdateState): void };
}

interface RegisterAppUpdateIpcOptions {
  service: AppUpdateService;
  ipcMain?: IpcMainLike;
  getWindows?: () => WindowLike[];
}

export function registerAppUpdateIpc(options: RegisterAppUpdateIpcOptions): void {
  const main = options.ipcMain ?? ipcMain;
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows());

  main.handle(IPC.APP_UPDATE_GET_STATE, () => options.service.getState());
  main.handle(IPC.APP_UPDATE_CHECK, () => options.service.check());
  main.handle(IPC.APP_UPDATE_DOWNLOAD, () => options.service.download());
  main.handle(IPC.APP_UPDATE_INSTALL, () => options.service.install());

  options.service.onStateChanged((state) => {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.APP_UPDATE_STATE, state);
    }
  });
}
