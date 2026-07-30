// Codex（ChatGPT 订阅）OAuth —— PKCE 登录 + token 刷新 + 加密落盘
//
// 事实来源：不是这份文件作者自己猜的，是对着 EvanZhouDev/openai-oauth 的源码
// （packages/core/src/runtime.ts、packages/openai-oauth/src/login.ts）核对过的：
// - client_id 是 OpenAI Codex 的公开注册值（app_EMoamEEZ73f0CkXaXp7hrann），不可自定义。
// - redirect_uri 必须是字面量 http://localhost:1455/auth/callback——host 用 "localhost"
//   （不是 127.0.0.1）、端口 1455，两者都是客户端注册里写死的，换了会在换 token 那步报
//   redirect_uri 不匹配。
// - 换 token（authorization_code）是 form 编码；刷新（refresh_token）是 JSON 编码。
//   这个不对称容易搞反。
// - accountId 藏在 id_token（拿不到就退 access_token）这个 JWT 的
//   claims["https://api.openai.com/auth"].chatgpt_account_id，没有就退顶层
//   chatgpt_account_id，再没有就退 organizations[0].id。
//
// 不做的事：不读/不写 ~/.codex/auth.json——那是 Codex CLI 自己的凭据。跟它抢同一个
// refresh_token 会导致其中一边刷新后另一边静默掉线（OAuth provider 刷新时通常会
// 轮换 refresh_token 并让旧的失效）。自己走一遍登录，自己管自己的 token。
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { safeStorage } from "electron";
import { proxyAwareFetch, type FetchLike } from "./proxy-fetch";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 提前刷新的余量：避免 token 恰好在请求飞行途中过期。 */
const REFRESH_SLACK_MS = 60 * 1000;

export interface CodexOAuthSession {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  accountId: string;
}

export interface CodexOAuthStatus {
  loggedIn: boolean;
  accountId?: string;
}

// ── 加密落盘：safeStorage（OS 钥匙串）→ 机器指纹 XOR 混淆 → 明文兜底 ──────
// 和 src/main/channels/settings-store.ts 的三级方案同思路；那边的 encryptField/
// decryptField 没有 export，这里就近自带一份，别的模块（claude-code-bridge.ts 之类）
// 也是各管各的存储，不是这个仓库缺一个共享 util。
const ENC_PREFIX = "enc:";
const OBF_PREFIX = "obf:";
const PLAIN_PREFIX = "plain:";

// 不缓存：isEncryptionAvailable() 本身就是个便宜的同步调用，缓存只会让"运行时环境
// 变了但读到的还是旧值"这种情况（比如测试里切换可用性）读到过期结果，省不了什么。
function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function getMachineKey(userDataDir: string): Buffer {
  const seed = `${userDataDir}::cyrene-codex-oauth-secret`;
  return createHash("sha256").update(seed).digest().subarray(0, 16);
}

function xorWithKey(buf: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return out;
}

function encryptBlob(plain: string, userDataDir: string): string {
  if (!plain) return "";
  if (isSafeStorageAvailable()) {
    try {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString("base64");
    } catch (err) {
      console.warn("[CodexOAuth] safeStorage.encryptString 失败，回退混淆:", err);
    }
  }
  const key = getMachineKey(userDataDir);
  return OBF_PREFIX + xorWithKey(Buffer.from(plain, "utf8"), key).toString("base64");
}

function decryptBlob(stored: string, userDataDir: string): string {
  if (!stored) return "";
  if (stored.startsWith(ENC_PREFIX)) {
    if (!isSafeStorageAvailable()) {
      console.warn("[CodexOAuth] safeStorage 不可用，无法解密 enc: 字段");
      return "";
    }
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
    } catch (err) {
      console.warn("[CodexOAuth] safeStorage.decryptString 失败:", err);
      return "";
    }
  }
  if (stored.startsWith(OBF_PREFIX)) {
    try {
      const key = getMachineKey(userDataDir);
      const buf = Buffer.from(stored.slice(OBF_PREFIX.length), "base64");
      return xorWithKey(buf, key).toString("utf8");
    } catch (err) {
      console.warn("[CodexOAuth] 混淆解码失败:", err);
      return "";
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  return stored;
}

async function loadSession(sessionPath: string, userDataDir: string): Promise<CodexOAuthSession | null> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn("[CodexOAuth] 读取会话文件失败:", e);
    return null;
  }
  const plain = decryptBlob(raw.trim(), userDataDir);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain) as CodexOAuthSession;
    if (typeof parsed.accessToken !== "string" || typeof parsed.accountId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSession(sessionPath: string, userDataDir: string, session: CodexOAuthSession): Promise<void> {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  const blob = encryptBlob(JSON.stringify(session), userDataDir);
  const tmp = `${sessionPath}.tmp`;
  await fs.writeFile(tmp, blob, "utf8");
  await fs.rename(tmp, sessionPath);
}

async function clearSessionFile(sessionPath: string): Promise<void> {
  await fs.rm(sessionPath, { force: true });
}

// ── PKCE ──────────────────────────────────────────────────────────────────
interface PkceRequest {
  state: string;
  codeVerifier: string;
  authorizationUrl: string;
}

function createPkceRequest(): PkceRequest {
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // 参照现存实现带上；具体是否仍必需没有官方文档确认，原始需求文档提醒过这类细节会漂移。
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");

  return { state, codeVerifier, authorizationUrl: url.toString() };
}

// ── 换 token / 刷新 ──────────────────────────────────────────────────────
interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

async function parseTokenResponse(res: Response): Promise<TokenResponse> {
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error_description?: string; message?: string };
      detail = parsed.error_description ?? parsed.message ?? "";
    } catch {
      // ignore，用空 detail
    }
    throw new Error(`Codex OAuth token 请求失败：HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  let parsed: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Codex OAuth token 响应不是合法 JSON。");
  }
  if (typeof parsed.access_token !== "string") {
    throw new Error("Codex OAuth token 响应缺少 access_token。");
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    idToken: typeof parsed.id_token === "string" ? parsed.id_token : undefined,
    expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined,
  };
}

/**
 * 授权码换 token —— form 编码。
 *
 * fetchImpl 必须是走代理的那个（见 proxy-fetch.ts）：auth.openai.com 在部分地区
 * 直连会被回 403 unsupported_country_region_territory，而浏览器授权那步是通的，
 * 症状会伪装成"OAuth 实现有 bug"。
 */
async function exchangeCode(
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  const res = await fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  return parseTokenResponse(res);
}

/** 刷新 —— JSON 编码。和上面的 form 编码不是笔误，是两个端点约定不一样。 */
async function refreshTokens(refreshToken: string, fetchImpl: FetchLike): Promise<TokenResponse> {
  const res = await fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  return parseTokenResponse(res);
}

// ── JWT accountId 提取（只读 claim，不验签——读自己的 token 做路由用途） ──
export function decodeJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (typeof token !== "string" || !token.includes(".")) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function deriveAccountId(idToken: string | undefined, accessToken: string | undefined): string | undefined {
  for (const token of [idToken, accessToken]) {
    const claims = decodeJwtClaims(token);
    if (!claims) continue;

    const authClaim = claims["https://api.openai.com/auth"];
    if (authClaim && typeof authClaim === "object") {
      const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string" && id) return id;
    }

    const topLevel = claims.chatgpt_account_id;
    if (typeof topLevel === "string" && topLevel) return topLevel;

    const organizations = claims.organizations;
    if (Array.isArray(organizations) && organizations.length > 0) {
      const first = organizations[0] as Record<string, unknown> | undefined;
      if (first && typeof first.id === "string" && first.id) return first.id;
    }
  }
  return undefined;
}

// ── 本地回环回调服务器：只接 127.0.0.1 / ::1，端口 1455 是注册死的，不能换。 ──
function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function receiveCallback(expectedState: string): Promise<{ code: string }> {
  const servers: Server[] = [];
  let settled = false;
  let resolveResult!: (v: { code: string }) => void;
  let rejectResult!: (e: Error) => void;
  const resultPromise = new Promise<{ code: string }>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const closeAll = () => {
    for (const s of servers) {
      try {
        // closeAllConnections 强制断开还挂着的 keep-alive 连接——只调 close() 只是
        // 停止接受新连接，已建立的连接会一直留着，下一次登录复用同一个端口时，
        // 客户端的连接池可能复用这条老连接，把请求送进已经"退休"的旧 handler 闭包里，
        // 导致新一轮登录莫名其妙收不到回调。
        s.closeAllConnections?.();
        s.close();
      } catch {
        // ignore
      }
    }
  };

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    closeAll();
    fn();
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end("<html><body>ChatGPT 登录失败，可以关闭此页面。</body></html>");
      finish(() => rejectResult(new Error(`Codex OAuth 授权失败：${error}`)));
      return;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!code || state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end("<html><body>登录回调无效，可以关闭此页面。</body></html>");
      finish(() => rejectResult(new Error("Codex OAuth 回调缺少 code 或 state 不匹配（可能的 CSRF）。")));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end("<html><body>登录成功，可以关闭此页面，回到 Cyrene。</body></html>");
    finish(() => resolveResult({ code }));
  };

  const timer = setTimeout(() => {
    finish(() => rejectResult(new Error("Codex 登录超时（5 分钟内未完成浏览器授权）。")));
  }, LOGIN_TIMEOUT_MS);
  timer.unref?.();

  const hosts = ["127.0.0.1", "::1"];
  let boundAny = false;
  for (const host of hosts) {
    const server = createServer(handler);
    try {
      await listenOnce(server, CALLBACK_PORT, host);
      servers.push(server);
      boundAny = true;
    } catch (err) {
      try {
        server.close();
      } catch {
        // ignore
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EADDRINUSE") {
        clearTimeout(timer);
        closeAll();
        throw new Error(
          `Codex 登录需要用 http://localhost:${CALLBACK_PORT}${CALLBACK_PATH} 接收回调，但端口 ${CALLBACK_PORT} ` +
            `已被占用。这个端口是 OpenAI 客户端注册写死的，没法换——请先关掉占用该端口的进程再重试。`,
        );
      }
      // EADDRNOTAVAIL / EAFNOSUPPORT（比如机器没开 IPv6）——忽略，继续试下一个 host。
    }
  }
  if (!boundAny) {
    clearTimeout(timer);
    throw new Error("Codex 登录回调服务器启动失败：没有可用的本地回环地址。");
  }

  return resultPromise;
}

// ── 对外接口 ────────────────────────────────────────────────────────────
export class CodexOAuthAuth {
  private session: CodexOAuthSession | null = null;
  private loaded = false;
  private refreshing: Promise<CodexOAuthSession> | null = null;

  constructor(
    private readonly sessionPath: string,
    private readonly userDataDir: string,
    private readonly openUrl: (url: string) => void,
    /** 缺省走 Chromium 网络栈（含代理）；测试注入假实现。见 proxy-fetch.ts 的说明。 */
    private readonly fetchImpl: FetchLike = proxyAwareFetch,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.session = await loadSession(this.sessionPath, this.userDataDir);
    this.loaded = true;
  }

  async getStatus(): Promise<CodexOAuthStatus> {
    await this.ensureLoaded();
    return this.session ? { loggedIn: true, accountId: this.session.accountId } : { loggedIn: false };
  }

  async logout(): Promise<void> {
    await this.ensureLoaded();
    this.session = null;
    await clearSessionFile(this.sessionPath);
  }

  /** 跑一次完整登录：起本地回调服务器 → 打开系统浏览器 → 等回调 → 换 token → 落盘。 */
  async login(): Promise<{ accountId: string }> {
    const pkce = createPkceRequest();
    const callbackPromise = receiveCallback(pkce.state);
    this.openUrl(pkce.authorizationUrl);

    const { code } = await callbackPromise;
    const token = await exchangeCode(code, pkce.codeVerifier, this.fetchImpl);
    const accountId = deriveAccountId(token.idToken, token.accessToken);
    if (!accountId) {
      throw new Error("Codex OAuth 登录成功但没能解出 accountId（token 里没找到 chatgpt_account_id）。");
    }

    const session: CodexOAuthSession = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
      accountId,
    };
    this.session = session;
    this.loaded = true;
    await saveSession(this.sessionPath, this.userDataDir, session);
    return { accountId };
  }

  /** 取一个可用的 access token；快过期（60s 内）就刷新。并发调用共享同一次刷新。 */
  async getValidAccessToken(): Promise<{ accessToken: string; accountId: string }> {
    await this.ensureLoaded();
    if (!this.session) {
      throw new Error("Codex 未登录：请先在设置里点击「登录 ChatGPT」。");
    }
    if (Date.now() < this.session.expiresAt - REFRESH_SLACK_MS) {
      return { accessToken: this.session.accessToken, accountId: this.session.accountId };
    }
    return this.refreshNow();
  }

  /** 上游返回 401 时的兜底：强制刷新一次再重试，不管 expiresAt 是否"看起来"还没到期。 */
  async forceRefresh(): Promise<{ accessToken: string; accountId: string }> {
    await this.ensureLoaded();
    if (!this.session) {
      throw new Error("Codex 未登录：请先在设置里点击「登录 ChatGPT」。");
    }
    return this.refreshNow();
  }

  private async refreshNow(): Promise<{ accessToken: string; accountId: string }> {
    if (this.refreshing) {
      const s = await this.refreshing;
      return { accessToken: s.accessToken, accountId: s.accountId };
    }
    const current = this.session;
    if (!current?.refreshToken) {
      throw new Error("Codex 登录已过期且没有可用的 refresh_token，请重新登录。");
    }
    this.refreshing = (async (): Promise<CodexOAuthSession> => {
      const token = await refreshTokens(current.refreshToken!, this.fetchImpl);
      const accountId = deriveAccountId(token.idToken, token.accessToken) ?? current.accountId;
      const next: CodexOAuthSession = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? current.refreshToken,
        expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
        accountId,
      };
      this.session = next;
      await saveSession(this.sessionPath, this.userDataDir, next);
      return next;
    })();
    try {
      const s = await this.refreshing;
      return { accessToken: s.accessToken, accountId: s.accountId };
    } finally {
      this.refreshing = null;
    }
  }
}
