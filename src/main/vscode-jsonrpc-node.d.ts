/**
 * `vscode-jsonrpc@9` 通过 package exports 暴露 `vscode-jsonrpc/node`。
 * 本项目仍使用 classic Node moduleResolution，故在不切换全仓库解析策略的前提下补齐该子路径声明。
 */
declare module "vscode-jsonrpc/node" {
  export interface MessageConnection {
    sendRequest(method: string, params?: unknown, token?: unknown): Promise<unknown>;
    sendNotification(method: string, params?: unknown): void;
    onRequest(method: string, handler: (params: any) => unknown): void;
    onNotification(method: string, handler: (params: any) => void): void;
    listen(): void;
    dispose(): void;
  }

  export function createMessageConnection(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ): MessageConnection;
}
