// channels/inbound-server —— 本地 HTTP server，給外部渠道（OpenClaw / Feishu）回調用。
//
// 安全策略：
//   - 只綁 127.0.0.1，外部網絡不可達
//   - 共享密鑰 header：X-Cyrene-Channel-Secret（啟動時自動生成 32 字節 hex）
//   - 路由前綴：/channels/<id>/inbound   /channels/<id>/healthz
//
// Phase 0 只搭骨架（健康檢查 + 路由框架）。Phase 1 接入 wechat 路由，Phase 2 接入 feishu 路由。
import * as http from "http";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { channelManager } from "./manager";
import type { ChannelId, IncomingMessage } from "./types";

const LOG = "[InboundServer]";
// Spotify Developer Dashboard uses this fixed localhost OAuth redirect.
const PREFERRED_LOCAL_PORT = 53854;

/** 給定 channelId + raw payload → IncomingMessage。每個 adapter 自己註冊。 */
export type NormalizeFn = (channel: ChannelId, raw: unknown) => IncomingMessage | null;

interface InboundRoute {
  channel: ChannelId;
  normalize: NormalizeFn;
}

const routes: InboundRoute[] = [];
const localRoutes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>>();

/** 註冊只綁定 localhost 的 GET 回呼（例如 OAuth redirect）。 */
export function registerLocalGetRoute(pathname: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>): void {
  localRoutes.set(`GET ${pathname}`, handler);
}

/** adapter 在 start() 時調用一次註冊自己的路由。重複註冊按 id 覆蓋。 */
export function registerInboundRoute(channel: ChannelId, normalize: NormalizeFn): void {
  const existing = routes.findIndex((r) => r.channel === channel);
  if (existing >= 0) routes[existing] = { channel, normalize };
  else routes.push({ channel, normalize });
}

/** 內部：檢查共享密鑰（僅當 secret 已設置時強制校驗） */
function checkSecret(req: http.IncomingMessage, secret: string): boolean {
  if (!secret) return true; // 未啟用時不校驗
  const got = req.headers["x-cyrene-channel-secret"];
  if (typeof got !== "string") return false;
  const expected = Buffer.from(secret, "utf8");
  const actual = Buffer.from(got, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 內部：讀 body */
function readBody(req: http.IncomingMessage, max = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 內部：構造響應 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  secret: string,
): Promise<void> {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const localHandler = localRoutes.get(`${req.method ?? "GET"} ${requestUrl.pathname}`);
  if (localHandler) {
    await localHandler(req, res);
    return;
  }
  // 健康檢查：免密鑰
  if (req.url === "/channels/healthz" && req.method === "GET") {
    sendJson(res, 200, { ok: true, channels: channelManager.listChannels() });
    return;
  }

  // 入站路由：/channels/<id>/inbound
  const m = /^\/channels\/([^/]+)\/inbound\/?$/.exec(req.url || "");
  if (m && req.method === "POST") {
    const channelId = decodeURIComponent(m[1]) as ChannelId;
    if (!checkSecret(req, secret)) {
      sendJson(res, 401, { ok: false, error: "invalid shared secret" });
      return;
    }
    const route = routes.find((r) => r.channel === channelId);
    if (!route) {
      sendJson(res, 404, { ok: false, error: `no route registered for channel: ${channelId}` });
      return;
    }
    let raw: unknown = null;
    try {
      const text = await readBody(req);
      raw = text ? JSON.parse(text) : null;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad json" });
      return;
    }
    let msg: IncomingMessage | null = null;
    try {
      msg = route.normalize(channelId, raw);
    } catch (err) {
      console.error(LOG, `normalize 失敗 [${channelId}]:`, err);
      sendJson(res, 500, { ok: false, error: "normalize failed" });
      return;
    }
    if (!msg) {
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }
    // 同步給 adapter.onMessage handler；handler 是 dispatcher
    const adapter = channelManager.getAdapter(channelId);
    if (!adapter || !adapter.onMessage) {
      sendJson(res, 503, { ok: false, error: "adapter not ready" });
      return;
    }
    try {
      const outgoing = await adapter.onMessage(msg);
      // 當前只回 ack；adapters 自己負責把 outgoing 真的發出去
      sendJson(res, 200, { ok: true, replied: outgoing != null });
    } catch (err) {
      console.error(LOG, `handler 失敗 [${channelId}]:`, err);
      sendJson(res, 500, { ok: false, error: "handler failed" });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

export interface InboundServerHandle {
  port: number;
  close(): Promise<void>;
}

let server: http.Server | null = null;
let currentHandle: InboundServerHandle | null = null;

/** 啟動 inbound-server（idempotent：如果已起且端口一致，直接返回現有 handle） */
export async function startInboundServer(): Promise<InboundServerHandle> {
  const settings = loadChannelsSettings();
  // 共享密鑰：首次啟動若為空則生成 32 字節隨機
  let secret = settings.sharedSecret;
  if (!secret) {
    const random = randomBytes(32).toString("hex");
    secret = random;
    saveChannelsSettings({ sharedSecret: secret });
  }

  if (currentHandle && server) {
    return currentHandle;
  }

  // 啟動策略：
  // 1) 優先使用 Spotify OAuth 已登記的固定 localhost port。
  // 2) 被佔時才嘗試上次保存的備用 port，再 fallback 到 OS 隨機分配。
  // 下次重啟仍會先回到固定 port，不讓暫時衝突永久破壞 OAuth callback。
  const tryPorts: Array<number | "random"> = [PREFERRED_LOCAL_PORT];
  if (settings.inboundPort > 0 && settings.inboundPort !== PREFERRED_LOCAL_PORT) tryPorts.push(settings.inboundPort);
  tryPorts.push("random");

  let lastErr: unknown = null;
  let actualPort = 0;
  for (const target of tryPorts) {
    if (server) {
      // 關閉上次失敗遺留的實例
      try {
        await new Promise<void>((r) => server!.close(() => r()));
      } catch {
        /* ignore */
      }
      server = null;
    }
    const port = target === "random" ? 0 : target;
    server = http.createServer((req, res) => {
      handleRequest(req, res, secret).catch((err) => {
        console.error(LOG, "unhandled:", err);
        try {
          sendJson(res, 500, { ok: false, error: "internal" });
        } catch {
          /* ignore */
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once("error", onError);
        server!.listen(port, "127.0.0.1", () => {
          server!.off("error", onError);
          resolve();
        });
      });
      const addr = server.address();
      actualPort = typeof addr === "object" && addr ? addr.port : 0;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(LOG, `端口 ${port === 0 ? "(random)" : port} 佔用, 嘗試下一個`);
      continue;
    }
  }

  if (!server || actualPort === 0) {
    throw lastErr instanceof Error ? lastErr : new Error("inbound-server 啟動失敗");
  }

  const port = actualPort;

  // 把真實端口寫回 settings（如果原來是 0 或撞了端口）
  if (settings.inboundPort !== port) {
    saveChannelsSettings({ inboundPort: port });
  }

  currentHandle = {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if (server) {
          server.close(() => {
            server = null;
            currentHandle = null;
            resolve();
          });
        } else {
          resolve();
        }
      }),
  };
  console.log(LOG, `啟動於 http://127.0.0.1:${port}`);
  return currentHandle;
}

/** 關閉（app 退出時調） */
export async function stopInboundServer(): Promise<void> {
  if (currentHandle) {
    await currentHandle.close();
  }
}

/** 給 runtime 計算一個 HMAC（用作 X-Cyrene-Channel-Secret 的 payload 簽名場景，備用） */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
