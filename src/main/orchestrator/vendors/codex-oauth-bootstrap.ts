// 把 CodexOAuthAuth + Codex 桥 + IPC 注册串起来，供 main/index.ts 一次性调用。
// 结构照抄 src/main/music/bootstrap.ts 的 bootstrap 惯例。
import { app, shell } from "electron";
import * as path from "node:path";
import { CodexOAuthAuth } from "./codex-oauth-auth";
import { startCodexBridge, type CodexBridgeHandle } from "./codex-bridge";
import { registerCodexOAuthIpcHandlers } from "./codex-oauth-ipc";

export interface CodexOAuthBootstrap {
  auth: CodexOAuthAuth;
  bridge: CodexBridgeHandle;
  dispose(): Promise<void>;
}

export async function bootstrapCodexOAuth(): Promise<CodexOAuthBootstrap> {
  const userDataDir = app.getPath("userData");
  const sessionPath = path.join(userDataDir, "codex-oauth-session.json");
  const auth = new CodexOAuthAuth(sessionPath, userDataDir, url => {
    void shell.openExternal(url);
  });
  const bridge = await startCodexBridge(auth);
  const disposeIpc = registerCodexOAuthIpcHandlers(auth, bridge);

  return {
    auth,
    bridge,
    dispose: async () => {
      disposeIpc();
      await bridge.close();
    },
  };
}
