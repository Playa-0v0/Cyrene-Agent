import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

export function exposeCodexOAuthApi() {
  contextBridge.exposeInMainWorld("codexOAuth", {
    getStatus: () => ipcRenderer.invoke(IPC.CODEX_OAUTH_GET_STATUS),
    beginLogin: () => ipcRenderer.invoke(IPC.CODEX_OAUTH_BEGIN_LOGIN),
    logout: () => ipcRenderer.invoke(IPC.CODEX_OAUTH_LOGOUT),
  });
}
