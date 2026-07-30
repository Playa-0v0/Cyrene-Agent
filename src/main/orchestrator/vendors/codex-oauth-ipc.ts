// Codex OAuth 的 IPC 暴露层 —— 设置窗口的「登录 ChatGPT」按钮走这里。
// 结构照抄 src/main/music/ipc-handlers.ts 的 register/dispose 惯例。
import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc-channels";
import type { CodexOAuthAuth } from "./codex-oauth-auth";
import type { CodexBridgeHandle } from "./codex-bridge";

export type CodexOAuthIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function wrap<T>(fn: () => Promise<T>): Promise<CodexOAuthIpcResult<T>> {
  return fn().then(
    data => ({ ok: true as const, data }),
    (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
  );
}

export interface CodexOAuthStatusPayload {
  loggedIn: boolean;
  accountId?: string;
  /** 桥的 baseUrl/token——登录成功后设置面板据此自动填 Base URL / API Key。 */
  bridge: { baseUrl: string; token: string };
}

export function registerCodexOAuthIpcHandlers(auth: CodexOAuthAuth, bridge: CodexBridgeHandle): () => void {
  const channels: string[] = [];

  ipcMain.handle(IPC.CODEX_OAUTH_GET_STATUS, () =>
    wrap(async (): Promise<CodexOAuthStatusPayload> => {
      const status = await auth.getStatus();
      return { ...status, bridge: { baseUrl: bridge.baseUrl, token: bridge.token } };
    }),
  );
  channels.push(IPC.CODEX_OAUTH_GET_STATUS);

  ipcMain.handle(IPC.CODEX_OAUTH_BEGIN_LOGIN, () => wrap(() => auth.login()));
  channels.push(IPC.CODEX_OAUTH_BEGIN_LOGIN);

  ipcMain.handle(IPC.CODEX_OAUTH_LOGOUT, () => wrap(() => auth.logout()));
  channels.push(IPC.CODEX_OAUTH_LOGOUT);

  return function dispose() {
    for (const ch of channels) ipcMain.removeHandler(ch);
  };
}
