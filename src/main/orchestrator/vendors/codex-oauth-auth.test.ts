import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHmac } from "node:crypto";

// Mock electron 的 safeStorage（不需要真钥匙串）——跟 channels/settings-store.test.ts 同套路。
let safeStorageEnabled = true;
const encState = new Map<string, string>();

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageEnabled,
    encryptString: (plain: string) => {
      const fake = Buffer.from("ENC(" + plain + ")").toString("base64");
      encState.set(plain, fake);
      return Buffer.from(fake, "base64");
    },
    decryptString: (buf: Buffer) => {
      const b64 = buf.toString("base64");
      for (const [plain, stored] of encState.entries()) {
        if (stored === b64) return plain;
      }
      throw new Error("mock decrypt failed");
    },
  },
}));

// 必须在 mock 之后 import
// eslint-disable-next-line import/first
import { CodexOAuthAuth, decodeJwtClaims, deriveAccountId } from "./codex-oauth-auth";

/**
 * 模拟浏览器把授权回调打回本地回环。
 *
 * login() 里 openUrl 是同步回调，此时回调服务器的 listen() 可能还没完成绑定
 * （真实场景里浏览器跳转耗时远长于此，不会撞上；测试里用 fetch 模拟瞬间回调就会撞上），
 * 所以用短重试代替真实浏览器的延迟。
 *
 * 绝不抛出：调用方是 fire-and-forget（openUrl 是同步的，没法 await）。
 * 一旦这里抛出就是没人接的 unhandled rejection —— 而 login() 成功后回调服务器立刻
 * 关闭，在途的 fetch 必然失败，于是 vitest worker 会被整个带崩（表现为
 * "Worker exited unexpectedly"，而不是某条用例失败，极难定位）。
 * 真正的断言在 login() 的返回值上，这里失败自然会体现为 login 超时/失败。
 */
async function postCallbackWithRetry(url: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

/**
 * 端口 1455 是 OpenAI 客户端注册写死的，多个测试背靠背 listen/close 同一个端口时，
 * Windows 偶尔要多等一拍才会真正释放（server.close() 不等 socket 完全释放就返回）。
 * 只在明确是"端口占用"这一类错误时重试，state 不匹配等真实业务错误照样立即冒泡。
 */
async function loginRetryingPortConflict(
  auth: CodexOAuthAuth,
  attempts = 5,
): Promise<{ accountId: string }> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await auth.login();
    } catch (err) {
      const isPortConflict = err instanceof Error && /已被占用/.test(err.message);
      if (!isPortConflict || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 50));
    }
  }
  throw new Error("unreachable");
}

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64url({ alg: "none", typ: "JWT" });
  const body = b64url(payload);
  // 签名部分不校验，测试不需要真签名。
  const sig = createHmac("sha256", "unused").update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

describe("decodeJwtClaims / deriveAccountId", () => {
  it("从 https://api.openai.com/auth claim 里拿 chatgpt_account_id", () => {
    const idToken = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
    expect(deriveAccountId(idToken, undefined)).toBe("acct_123");
  });

  it("回退到顶层 chatgpt_account_id", () => {
    const idToken = fakeJwt({ chatgpt_account_id: "acct_top" });
    expect(deriveAccountId(idToken, undefined)).toBe("acct_top");
  });

  it("再回退到 organizations[0].id", () => {
    const idToken = fakeJwt({ organizations: [{ id: "org_1" }] });
    expect(deriveAccountId(idToken, undefined)).toBe("org_1");
  });

  it("id_token 解不出时退到 access_token", () => {
    const accessToken = fakeJwt({ chatgpt_account_id: "acct_from_access" });
    expect(deriveAccountId(undefined, accessToken)).toBe("acct_from_access");
  });

  it("两个 token 都没有可用 claim 时返回 undefined", () => {
    expect(deriveAccountId(fakeJwt({}), fakeJwt({}))).toBeUndefined();
  });

  it("非法 token（非三段式）返回 undefined claims", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeUndefined();
    expect(decodeJwtClaims(undefined)).toBeUndefined();
  });
});

describe("CodexOAuthAuth", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-test-"));
    sessionPath = path.join(tmpDir, "codex-oauth-session.json");
    encState.clear();
    safeStorageEnabled = true;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("未登录时 getStatus 返回 loggedIn: false，getValidAccessToken 抛出明确错误", async () => {
    const auth = new CodexOAuthAuth(sessionPath, tmpDir, () => {});
    expect(await auth.getStatus()).toEqual({ loggedIn: false });
    await expect(auth.getValidAccessToken()).rejects.toThrow(/未登录/);
  });

  it("并发 getValidAccessToken 在 token 过期时只触发一次刷新（加锁）", async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      refreshCalls++;
      // 制造一点延迟，确保两次并发调用真的会撞上同一次 in-flight 刷新
      await new Promise(r => setTimeout(r, 20));
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
        { status: 200 },
      );
    });
    const auth = new CodexOAuthAuth(sessionPath, tmpDir, () => {}, fetchMock);
    // 直接走一次真实登录不现实（需要真端口 1455 + 真浏览器），这里通过内部字段注入一个
    // 已过期、带 refreshToken 的会话，只测 getValidAccessToken 的刷新加锁行为。
    (auth as unknown as { session: unknown; loaded: boolean }).session = {
      accessToken: "old-access",
      refreshToken: "refresh-abc",
      expiresAt: Date.now() - 1000,
      accountId: "acct_1",
    };
    (auth as unknown as { loaded: boolean }).loaded = true;

    const [a, b] = await Promise.all([auth.getValidAccessToken(), auth.getValidAccessToken()]);
    expect(refreshCalls).toBe(1);
    expect(a.accessToken).toBe("new-access");
    expect(b.accessToken).toBe("new-access");
  });

  it("刷新使用 JSON 编码，换 token 用 form 编码——两者不能搞反", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-xyz" });
      return new Response(JSON.stringify({ access_token: "next", expires_in: 3600 }), { status: 200 });
    });
    const auth = new CodexOAuthAuth(sessionPath, tmpDir, () => {}, fetchMock);
    (auth as unknown as { session: unknown; loaded: boolean }).session = {
      accessToken: "old",
      refreshToken: "refresh-xyz",
      expiresAt: Date.now() - 1000,
      accountId: "acct_1",
    };
    (auth as unknown as { loaded: boolean }).loaded = true;

    await auth.getValidAccessToken();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("刷新失败（无 refreshToken）时给出清楚的重新登录提示", async () => {
    const auth = new CodexOAuthAuth(sessionPath, tmpDir, () => {});
    (auth as unknown as { session: unknown; loaded: boolean }).session = {
      accessToken: "old",
      expiresAt: Date.now() - 1000,
      accountId: "acct_1",
    };
    (auth as unknown as { loaded: boolean }).loaded = true;
    await expect(auth.getValidAccessToken()).rejects.toThrow(/重新登录/);
  });

  it("会话加密落盘后能在新实例里还原（safeStorage 可用时）", async () => {
    const refreshOk = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }),
        { status: 200 },
      ),
    );
    const auth1 = new CodexOAuthAuth(sessionPath, tmpDir, () => {}, refreshOk);
    (auth1 as unknown as { session: unknown; loaded: boolean }).session = {
      accessToken: "a",
      refreshToken: "r",
      // 故意设成已过期：走 getValidAccessToken 的"未过期直接返回"分支不会写盘，
      // 只有刷新路径才落盘，而刷新更贴近真实使用路径（比直接调私有 saveSession 好）。
      expiresAt: Date.now() - 1000,
      accountId: "acct_persist",
    };
    (auth1 as unknown as { loaded: boolean }).loaded = true;
    await auth1.getValidAccessToken();

    const auth2 = new CodexOAuthAuth(sessionPath, tmpDir, () => {});
    const status = await auth2.getStatus();
    expect(status).toEqual({ loggedIn: true, accountId: "acct_persist" });
  });

  it("safeStorage 不可用时回退机器指纹混淆，仍能 round-trip", async () => {
    safeStorageEnabled = false;
    const refreshOk = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "a2", expires_in: 3600 }), { status: 200 }),
    );
    const auth1 = new CodexOAuthAuth(sessionPath, tmpDir, () => {}, refreshOk);
    (auth1 as unknown as { session: unknown; loaded: boolean }).session = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() - 1000,
      accountId: "acct_obf",
    };
    (auth1 as unknown as { loaded: boolean }).loaded = true;
    await auth1.getValidAccessToken();

    const raw = fs.readFileSync(sessionPath, "utf8");
    expect(raw.startsWith("obf:")).toBe(true);

    const auth2 = new CodexOAuthAuth(sessionPath, tmpDir, () => {});
    expect(await auth2.getStatus()).toEqual({ loggedIn: true, accountId: "acct_obf" });
  });

  it("logout 清空会话并删除落盘文件", async () => {
    const auth = new CodexOAuthAuth(sessionPath, tmpDir, () => {});
    (auth as unknown as { session: unknown; loaded: boolean }).session = {
      accessToken: "a",
      expiresAt: Date.now() + 3600_000,
      accountId: "acct_1",
    };
    (auth as unknown as { loaded: boolean }).loaded = true;
    fs.writeFileSync(sessionPath, "plain:{}");

    await auth.logout();
    expect(await auth.getStatus()).toEqual({ loggedIn: false });
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  // 端到端登录：真绑 127.0.0.1:1455（OpenAI 客户端注册写死的端口，测不了别的），
  // 用真实 HTTP 请求模拟浏览器把授权码回传到 /auth/callback；换 token 那一跳注入假 fetch。
  // 这是唯一一处验证 PKCE 请求参数形状（state/code_challenge/redirect_uri）的地方。
  it("login() 端到端：state 匹配、redirect_uri 是字面量 localhost:1455、accountId 解得出来", async () => {
    const idToken = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_e2e" } });
    const tokenFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      const params = new URLSearchParams(init!.body as string);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("test-code");
      // code_verifier 必须回传，且是 PKCE 那一份（长度足够、URL-safe）
      expect(params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      return new Response(
        JSON.stringify({ access_token: "tok", refresh_token: "ref", id_token: idToken, expires_in: 3600 }),
        { status: 200 },
      );
    });

    const auth = new CodexOAuthAuth(
      sessionPath,
      tmpDir,
      url => {
        const parsed = new URL(url);
        expect(parsed.origin).toBe("https://auth.openai.com");
        expect(parsed.pathname).toBe("/oauth/authorize");
        expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
        expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
        expect(parsed.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
        const state = parsed.searchParams.get("state");
        expect(state).toBeTruthy();
        // 模拟浏览器把授权服务器的回调打回本地回环——真实 TCP 请求，用的是全局 fetch，
        // 跟注入的 tokenFetch 互不干扰（这正是注入比 stubGlobal 干净的地方）。
        void postCallbackWithRetry(`http://127.0.0.1:1455/auth/callback?code=test-code&state=${state}`);
      },
      tokenFetch,
    );

    const result = await loginRetryingPortConflict(auth);
    expect(result.accountId).toBe("acct_e2e");
    expect(await auth.getStatus()).toEqual({ loggedIn: true, accountId: "acct_e2e" });
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it("login() 拒绝 state 不匹配的回调（CSRF 防护）", async () => {
    // state 不匹配就该在回调那一步失败，绝不能走到换 token —— 用一个"被调用就炸"的
    // fetch 把这条不变量钉住。
    const mustNotBeCalled = vi.fn(async () => {
      throw new Error("state 不匹配时不应该发起 token 交换");
    });
    const auth = new CodexOAuthAuth(
      sessionPath,
      tmpDir,
      () => {
        void postCallbackWithRetry("http://127.0.0.1:1455/auth/callback?code=test-code&state=wrong-state");
      },
      mustNotBeCalled,
    );
    await expect(loginRetryingPortConflict(auth)).rejects.toThrow(/state 不匹配/);
    expect(mustNotBeCalled).not.toHaveBeenCalled();
  });
});
