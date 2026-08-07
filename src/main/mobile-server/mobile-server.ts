// mobile-server —— 局域網 HTTP + WebSocket 伺服器，供手機 PWA 聊天介面連接。
//
// 安全策略：
//   - 綁定 0.0.0.0（局域網可達，與 inbound-server 只綁 127.0.0.1 不同）
//   - 啟動時自動生成 6 位數字 token，顯示在 Electron 主窗口通知裡
//   - 所有 WebSocket 握手和 API 請求必須帶 ?token=<token> 或 X-Mobile-Token header
//
// 協議：
//   HTTP  GET  /mobile/         → 提供 mobile/ 目錄的靜態文件（index.html、app.js、style.css）
//   HTTP  GET  /mobile/healthz  → 健康檢查（免 token）
//   HTTP  GET  /mobile/sessions → 會話列表
//   HTTP  POST /mobile/sessions → 建新會話
//   HTTP  GET  /mobile/sessions/:id → 取會話詳情
//   WS    ws://[ip]:[port]/mobile/chat → 聊天事件流
//
// WebSocket 消息（Client → Server）：
//   { type: "run", sessionId, messages, style }
//   { type: "cancel" }
//
// WebSocket 消息（Server → Client）：
//   AG-UI BaseEvent 透傳（TEXT_MESSAGE_CONTENT, RUN_FINISHED, RUN_ERROR, ...）
//   { type: "CYRENE_STICKER", sticker: string }
//   { type: "CONN_ACK", version: "1" }
//   { type: "ERROR", message: string }

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as WebSocket from "ws";
const { Server: WebSocketServer } = WebSocket;
import { randomBytes } from "crypto";
import { CyreneAgent, type CyreneRunOptions } from "../orchestrator/cyrene-agent";
import { appendConversationEntry } from "../memory/conversation-archive";
import * as chatsStore from "../chats/chats-store";
import type { AguiRunInput, BuildOptionsFn, OnRunFinishedFn } from "../agui-bridge";
import { indexConversationTurn } from "../orchestrator/history-tools";

const LOG = "[MobileServer]";
const MOBILE_PORT = 45678;
const MOBILE_DIR = path.join(__dirname, "..", "..", "..", "..", "mobile");

export interface MobileServerHandle {
  port: number;
  token: string;
  localIp: string;
  close(): Promise<void>;
}

let serverHandle: MobileServerHandle | null = null;
let buildOptionsFn: BuildOptionsFn | null = null;
let onRunFinishedFn: OnRunFinishedFn | null = null;

/** 取第一個局域網 IPv4 地址（排除 127.x） */
function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

/** 生成 6 位數字 token */
function generateToken(): string {
  const n = parseInt(randomBytes(3).toString("hex"), 16) % 1000000;
  return String(n).padStart(6, "0");
}

/** 讀文件，返回 Buffer 或 null */
function tryReadFile(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/** 根據副檔名取 MIME type */
function getMime(ext: string): string {
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
  };
  return map[ext] ?? "application/octet-stream";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function sendStatic(res: http.ServerResponse, filePath: string): void {
  const buf = tryReadFile(filePath);
  if (!buf) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": getMime(ext),
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

function checkToken(req: http.IncomingMessage, token: string): boolean {
  // Header 優先
  const headerVal = req.headers["x-mobile-token"];
  if (typeof headerVal === "string" && headerVal === token) return true;
  // Query string 兜底
  const url = new URL(req.url || "/", "http://localhost");
  if (url.searchParams.get("token") === token) return true;
  return false;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 處理 HTTP 請求 */
async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
  const urlStr = req.url || "/";
  const url = new URL(urlStr, "http://localhost");
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Mobile-Token",
    });
    res.end();
    return;
  }

  // 健康檢查：免 token
  if (pathname === "/mobile/healthz" && req.method === "GET") {
    sendJson(res, 200, { ok: true, version: "1" });
    return;
  }

  // 靜態文件：提供 mobile/ 目錄（免 token）
  if (pathname === "/" || pathname === "/mobile" || pathname === "/mobile/") {
    sendStatic(res, path.join(MOBILE_DIR, "index.html"));
    return;
  }
  if (pathname.startsWith("/mobile/") && req.method === "GET") {
    // 避免路徑穿越
    const rel = pathname.slice("/mobile/".length);
    if (rel && !rel.includes("..") && !rel.startsWith("/")) {
      const filePath = path.join(MOBILE_DIR, rel);
      if (filePath.startsWith(MOBILE_DIR)) {
        sendStatic(res, filePath);
        return;
      }
    }
  }

  // 以下 API 需要 token
  if (!checkToken(req, token)) {
    sendJson(res, 401, { ok: false, error: "invalid token" });
    return;
  }

  // GET /api/sessions → 會話列表
  if (pathname === "/api/sessions" && req.method === "GET") {
    try {
      const sessions = chatsStore.listSessions();
      sendJson(res, 200, sessions);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  // POST /api/sessions → 建新會話
  if (pathname === "/api/sessions" && req.method === "POST") {
    try {
      const session = chatsStore.createSession({ title: undefined, identityId: null });
      sendJson(res, 200, session);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  // GET /api/sessions/:id → 取會話詳情
  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (sessionMatch && req.method === "GET") {
    const id = decodeURIComponent(sessionMatch[1]);
    try {
      const session = chatsStore.getSession(id);
      if (!session) {
        sendJson(res, 404, { ok: false, error: "session not found" });
      } else {
        sendJson(res, 200, session);
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  // PATCH /api/sessions/:id/messages → 更新會話消息（用於持久化）
  const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (messagesMatch && req.method === "POST") {
    const id = decodeURIComponent(messagesMatch[1]);
    try {
      const body = await readBody(req);
      const { messages } = JSON.parse(body) as { messages: unknown[] };
      chatsStore.replaceMessages(id, messages as any);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

/** 啟動 Mobile Server（idempotent） */
export async function startMobileServer(
  buildOptions: BuildOptionsFn,
  onRunFinished: OnRunFinishedFn,
): Promise<MobileServerHandle> {
  if (serverHandle) return serverHandle;

  buildOptionsFn = buildOptions;
  onRunFinishedFn = onRunFinished;

  // 確保 chats-store 已初始化（由 registerChatsIpc 負責，這裡保險起見再呼叫）
  chatsStore.initialize();

  const token = generateToken();
  const localIp = getLocalIp();

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res, token).catch((err) => {
      console.error(LOG, "HTTP error:", err);
      try { sendJson(res, 500, { ok: false, error: "internal" }); } catch { /* ignore */ }
    });
  });

  // WebSocket 伺服器
  const wss = new WebSocketServer({ server: httpServer, path: "/mobile/chat" });

  wss.on("connection", (ws: WebSocket.WebSocket, req: http.IncomingMessage) => {
    // 驗證 token（query string）
    const url = new URL(req.url || "/", "http://localhost");
    const clientToken = url.searchParams.get("token");
    if (clientToken !== token) {
      ws.send(JSON.stringify({ type: "ERROR", message: "invalid token" }));
      ws.close(4001, "unauthorized");
      return;
    }

    console.log(LOG, "手機客戶端已連接");
    ws.send(JSON.stringify({ type: "CONN_ACK", version: "1" }));

    let currentRunAbort: (() => void) | null = null;

    ws.on("message", async (raw: Buffer) => {
      let msg: { type: string; sessionId?: string; messages?: unknown[]; style?: string };
      try {
        msg = JSON.parse(raw.toString("utf8")) as typeof msg;
      } catch {
        ws.send(JSON.stringify({ type: "ERROR", message: "invalid json" }));
        return;
      }

      if (msg.type === "cancel") {
        currentRunAbort?.();
        currentRunAbort = null;
        return;
      }

      if (msg.type === "run") {
        if (!buildOptionsFn || !onRunFinishedFn) {
          ws.send(JSON.stringify({ type: "RUN_ERROR", error: "server not initialized" }));
          return;
        }

        const input: AguiRunInput = {
          messages: msg.messages ?? [],
          style: msg.style ?? "01_default.md",
          sessionId: msg.sessionId,
          channel: "desktop",
        };

        let aborted = false;
        currentRunAbort = () => { aborted = true; };

        try {
          const { options, latestUserText } = await buildOptionsFn(input);
          const runId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const archiveTurnId = `mobile:${input.sessionId || "default"}:${runId}`;

          // 存用戶原話
          appendConversationEntry({
            id: `${archiveTurnId}:user`,
            sessionId: input.sessionId || "default",
            channel: "desktop",
            role: "user",
            content: latestUserText,
            at: Date.now(),
          });

          const agent = new CyreneAgent({ threadId: `mobile-thread-${Date.now()}`, description: "Cyrene 手機聊天" });

          const send = (event: unknown): void => {
            if (aborted || ws.readyState !== WebSocket.WebSocket.OPEN) return;
            try {
              ws.send(JSON.stringify(event));
            } catch (err) {
              console.warn(LOG, "WS send failed:", err);
            }
          };

          let pendingRunFinished: unknown = null;

          const sub = agent.runWithEvents(options as CyreneRunOptions).subscribe({
            next: (baseEvent) => {
              if ((baseEvent as { type?: string })?.type === "RUN_FINISHED") {
                pendingRunFinished = baseEvent;
                return;
              }
              send(baseEvent);
            },
            error: (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error(LOG, "run 失敗:", message);
              send({ type: "RUN_ERROR", error: message, runId });
            },
            complete: async () => {
              try {
                if (agent.lastResult) {
                  await onRunFinishedFn!(agent.lastResult, latestUserText);
                  // 注：sticker 已透過 agent 的 CUSTOM event (cyrene.sticker) 在 next() 裡廣播給前端，
                  // onRunFinished 的副作用（記憶/關係）在此執行即可。
                  void indexConversationTurn(
                    input.sessionId || "default",
                    latestUserText,
                    agent.lastResult.reply,
                    { channel: "desktop", turnId: archiveTurnId },
                  );
                }
              } catch (err) {
                console.warn(LOG, "副作用失敗:", err);
              }
              if (pendingRunFinished) {
                send(pendingRunFinished);
              }
            },
          });

          // 掛載取消函數
          currentRunAbort = () => {
            aborted = true;
            sub.unsubscribe();
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(LOG, "buildOptions 失敗:", message);
          ws.send(JSON.stringify({ type: "RUN_ERROR", error: message }));
        }
        return;
      }
    });

    ws.on("close", () => {
      console.log(LOG, "手機客戶端已斷開");
      currentRunAbort?.();
    });

    ws.on("error", (err) => {
      console.warn(LOG, "WebSocket 錯誤:", err.message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(MOBILE_PORT, "0.0.0.0", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  serverHandle = {
    port: MOBILE_PORT,
    token,
    localIp,
    close: () => new Promise<void>((resolve) => {
      wss.close(() => {
        httpServer.close(() => {
          serverHandle = null;
          resolve();
        });
      });
    }),
  };

  console.log(LOG, `啟動於 http://${localIp}:${MOBILE_PORT}`);
  console.log(LOG, `連接 Token: ${token}`);
  return serverHandle;
}

export async function stopMobileServer(): Promise<void> {
  if (serverHandle) {
    await serverHandle.close();
  }
}

export function getMobileServerHandle(): MobileServerHandle | null {
  return serverHandle;
}
