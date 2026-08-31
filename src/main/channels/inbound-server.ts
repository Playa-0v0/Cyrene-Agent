// channels/inbound-server —— 本地 HTTP server，给外部渠道（OpenClaw / Feishu）回调用。
//
// 安全策略：
//   - 只绑 127.0.0.1，外部网络不可达
//   - 共享密钥 header：X-Cyrene-Channel-Secret（启动时自动生成 32 字节 hex）
//   - 路由前缀：/channels/<id>/inbound   /channels/<id>/healthz
//
// Phase 0 只搭骨架（健康检查 + 路由框架）。Phase 1 接入 wechat 路由，Phase 2 接入 feishu 路由。
import * as http from "http";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { channelManager } from "./manager";
import type { ChannelId, IncomingMessage } from "./types";
import { logger, LogTag } from "../logger";

const LOG = "[InboundServer]";

/** 给定 channelId + raw payload → IncomingMessage。每个 adapter 自己注册。 */
export type NormalizeFn = (channel: ChannelId, raw: unknown) => IncomingMessage | null;

interface InboundRoute {
  channel: ChannelId;
  normalize: NormalizeFn;
}

const routes: InboundRoute[] = [];

/** adapter 在 start() 时调用一次注册自己的路由。重复注册按 id 覆盖。 */
export function registerInboundRoute(channel: ChannelId, normalize: NormalizeFn): void {
  const existing = routes.findIndex((r) => r.channel === channel);
  if (existing >= 0) routes[existing] = { channel, normalize };
  else routes.push({ channel, normalize });
}

/** 内部：检查共享密钥（仅当 secret 已设置时强制校验） */
function checkSecret(req: http.IncomingMessage, secret: string): boolean {
  if (!secret) return true; // 未启用时不校验
  const got = req.headers["x-cyrene-channel-secret"];
  if (typeof got !== "string") return false;
  const expected = Buffer.from(secret, "utf8");
  const actual = Buffer.from(got, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 内部：读 body */
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

/** 内部：构造响应 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  secret: string,
): Promise<void> {
  // 健康检查：免密钥
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
      console.error(LOG, `normalize 失败 [${channelId}]:`, err);
      sendJson(res, 500, { ok: false, error: "normalize failed" });
      return;
    }
    if (!msg) {
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }
    // 同步给 adapter.onMessage handler；handler 是 dispatcher
    const adapter = channelManager.getAdapter(channelId);
    if (!adapter || !adapter.onMessage) {
      sendJson(res, 503, { ok: false, error: "adapter not ready" });
      return;
    }
    try {
      const outgoing = await adapter.onMessage(msg);
      // 当前只回 ack；adapters 自己负责把 outgoing 真的发出去
      sendJson(res, 200, { ok: true, replied: outgoing != null });
    } catch (err) {
      console.error(LOG, `handler 失败 [${channelId}]:`, err);
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

/** 启动 inbound-server（idempotent：如果已起且端口一致，直接返回现有 handle） */
export async function startInboundServer(): Promise<InboundServerHandle> {
  const settings = loadChannelsSettings();
  // 共享密钥：首次启动若为空则生成 32 字节随机
  let secret = settings.sharedSecret;
  if (!secret) {
    const random = randomBytes(32).toString("hex");
    secret = random;
    saveChannelsSettings({ sharedSecret: secret });
  }

  if (currentHandle && server) {
    return currentHandle;
  }

  // 启动策略：
  // 1) 优先用 settings.inboundPort（如果非 0）
  // 2) 被占 → fallback 到 0（OS 随机分）
  // 3) 仍被占 → 最多重试 3 次（每次都换 server 实例）
  const tryPorts: Array<number | "random"> = [];
  if (settings.inboundPort > 0) tryPorts.push(settings.inboundPort);
  tryPorts.push("random");

  let lastErr: unknown = null;
  let actualPort = 0;
  for (const target of tryPorts) {
    if (server) {
      // 关闭上次失败遗留的实例
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
      logger.warn(LogTag.InboundServer, `port ${port === 0 ? "(random)" : port} in use, trying next`);
      continue;
    }
  }

  if (!server || actualPort === 0) {
    throw lastErr instanceof Error ? lastErr : new Error("inbound-server 启动失败");
  }

  const port = actualPort;

  // 把真实端口写回 settings（如果原来是 0 或撞了端口）
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
  logger.info(LogTag.InboundServer, `listening on http://127.0.0.1:${port}`);
  return currentHandle;
}

/** 关闭（app 退出时调） */
export async function stopInboundServer(): Promise<void> {
  if (currentHandle) {
    await currentHandle.close();
  }
}

/** 给 runtime 计算一个 HMAC（用作 X-Cyrene-Channel-Secret 的 payload 签名场景，备用） */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}