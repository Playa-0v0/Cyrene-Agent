import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenapiLoginOrchestrator } from "./openapi-login-orchestrator";
import type { NeteaseOpenapiClient, QrLoginStatus } from "./netease-openapi-client";
import type { TokenVault } from "./token-vault";

function makeClient() {
  return {
    loginAnonymous: vi.fn(),
    getQrCodeKey: vi.fn(),
    checkQrLoginStatus: vi.fn(),
    setAccessToken: vi.fn(),
    getUserProfile: vi.fn(),
  };
}
function makeVault() {
  return {
    persist: vi.fn().mockResolvedValue(true),
    load: vi.fn(),
    decrypt: vi.fn(),
    isFresh: vi.fn(() => true),
  };
}

let client: ReturnType<typeof makeClient>;
let vault: ReturnType<typeof makeVault>;
let orch: OpenapiLoginOrchestrator;

beforeEach(() => {
  client = makeClient();
  vault = makeVault();
  client.loginAnonymous.mockResolvedValue({ accessToken: "anon", refreshToken: "", expireTime: 86400 });
  client.getQrCodeKey.mockResolvedValue({ qrCodeUrl: "https://163cn.tv/abc", uniKey: "k1" });
  orch = new OpenapiLoginOrchestrator({
    client: client as unknown as NeteaseOpenapiClient,
    vault: vault as unknown as TokenVault,
    qrValidityMs: 60_000,
    pollIntervalMs: 10,
  });
});

describe("OpenapiLoginOrchestrator", () => {
  it("beginLogin: gets anon token, QR key, returns qrContent + uniKey", async () => {
    const r = (await orch.beginLogin()) as Extract<
      Awaited<ReturnType<OpenapiLoginOrchestrator["beginLogin"]>>,
      { uniKey: string }
    >;
    expect(r.uniKey).toBe("k1");
    expect(r.qrContent).toBe("https://163cn.tv/abc");
    expect(r.pollIntervalMs).toBe(10);
    expect(client.loginAnonymous).toHaveBeenCalledTimes(1);
    expect(client.setAccessToken).toHaveBeenCalledWith("anon");
    expect(orch.getFlowState()).toBe("waiting_scan");
  });

  it("second beginLogin while QR still live reuses the same QR (no dead-end)", async () => {
    client.checkQrLoginStatus.mockResolvedValue({ status: 801 } as QrLoginStatus);
    await orch.beginLogin();
    const second = (await orch.beginLogin()) as { uniKey: string; qrContent: string };
    // 复用旧码：同一张二维码，不消耗新的匿名登录
    expect(second.qrContent).toBe("https://163cn.tv/abc");
    expect(second.uniKey).toBe("k1");
    expect(client.loginAnonymous).toHaveBeenCalledTimes(1);
  });

  it("orphaned session with phone-confirmed auth is consumed by next beginLogin (803 recovery)", async () => {
    const status803: QrLoginStatus = {
      status: 803,
      accessToken: { accessToken: "user-tok", refreshToken: "rt", expireTime: 86400 },
    };
    await orch.beginLogin();
    // 模拟孤儿会话：用户已在手机确认授权，但 app 轮询早已停止
    client.checkQrLoginStatus.mockResolvedValue(status803);

    const second = (await orch.beginLogin()) as { status: string };
    expect(second.status).toBe("login_already_active");
    expect(orch.getAccountState()).toBe("signed_in");
    expect(client.setAccessToken).toHaveBeenCalledWith("user-tok");
    await vi.waitFor(() => expect(vault.persist).toHaveBeenCalledTimes(1));
  });

  it("orphaned expired session is discarded; beginLogin generates a fresh QR", async () => {
    client.checkQrLoginStatus.mockResolvedValue({ status: 800 } as QrLoginStatus);
    await orch.beginLogin();
    const second = (await orch.beginLogin()) as { uniKey: string; qrContent: string };
    expect(second.qrContent).toBe("https://163cn.tv/abc");
    expect(client.loginAnonymous).toHaveBeenCalledTimes(2);
    expect(orch.getFlowState()).toBe("waiting_scan");
  });

  it("polls 801→802→803, persists token exactly once, sets signed_in", async () => {
    const status803: QrLoginStatus = {
      status: 803,
      accessToken: { accessToken: "user-tok", refreshToken: "rt", expireTime: 86400 },
    };
    client.checkQrLoginStatus
      .mockResolvedValueOnce({ status: 801 } as QrLoginStatus)
      .mockResolvedValueOnce({ status: 802 } as QrLoginStatus)
      .mockResolvedValueOnce(status803);

    await orch.beginLogin();
    expect((await orch.pollOnce()).status).toBe("waiting_scan");
    expect((await orch.pollOnce()).status).toBe("waiting_confirm");
    const final = await orch.pollOnce();
    expect(final.status).toBe("authorized");
    expect(orch.getAccountState()).toBe("signed_in");

    // Wait for fire-and-forget persist.
    await vi.waitFor(() => expect(vault.persist).toHaveBeenCalledTimes(1));
    expect(vault.persist).toHaveBeenCalledWith({
      accessToken: "user-tok",
      refreshToken: "rt",
      expireTime: 86400,
      gotAt: expect.any(Number),
    });
    expect(client.setAccessToken).toHaveBeenCalledWith("user-tok");

    // Idempotent: second poll doesn't re-persist.
    await orch.pollOnce();
    await vi.waitFor(() => expect(vault.persist).toHaveBeenCalledTimes(1));
  });

  it("800 → expired", async () => {
    client.checkQrLoginStatus.mockResolvedValue({ status: 800 } as QrLoginStatus);
    await orch.beginLogin();
    const r = await orch.pollOnce();
    expect(r.status).toBe("expired");
    expect(orch.getFlowState()).toBe("expired");
  });

  it("local expiry guard fires before server 800", async () => {
    orch = new OpenapiLoginOrchestrator({
      client: client as unknown as NeteaseOpenapiClient,
      vault: vault as unknown as TokenVault,
      qrValidityMs: 0, // instant expiry
    });
    await orch.beginLogin();
    const r = await orch.pollOnce();
    expect(r.status).toBe("expired");
  });

  it("cancelLogin flips to cancelled; late cancel after authorized is no-op", async () => {
    const status803: QrLoginStatus = {
      status: 803,
      accessToken: { accessToken: "t", refreshToken: "r", expireTime: 86400 },
    };
    client.checkQrLoginStatus.mockResolvedValue(status803);

    await orch.beginLogin();
    await orch.pollOnce(); // authorized

    await orch.cancelLogin();
    expect(orch.getFlowState()).toBe("authorized"); // late cancel no-op
    expect(orch.getAccountState()).toBe("signed_in");
  });

  it("cancelLogin before authorized → cancelled", async () => {
    await orch.beginLogin();
    await orch.cancelLogin();
    expect(orch.getFlowState()).toBe("cancelled");
  });

  it("unknown status → failed with code", async () => {
    client.checkQrLoginStatus.mockResolvedValue({ status: 999 } as unknown as QrLoginStatus);
    await orch.beginLogin();
    const r = (await orch.pollOnce()) as { status: string; errorCode: string };
    expect(r.status).toBe("failed");
    expect(r.errorCode).toContain("E_UNKNOWN_QR_STATUS_999");
  });

  it("inFlight guard keeps waiting (slow network must not kill the QR)", async () => {
    client.checkQrLoginStatus.mockImplementation(
      () => new Promise((res) => setTimeout(() => res({ status: 801 }), 50)),
    );
    await orch.beginLogin();
    const p1 = orch.pollOnce();
    const p2 = orch.pollOnce();
    const [r1, r2] = await Promise.all([p1, p2]);
    // 慢于轮询间隔的响应不是失败——两个都保持等待态，二维码不消失
    expect(r1.status).toBe("waiting_scan");
    expect(r2.status).toBe("waiting_scan");
    expect(orch.getFlowState()).toBe("waiting_scan");
  });

  it("transient poll errors are tolerated; QR flow stays alive", async () => {
    client.checkQrLoginStatus
      .mockRejectedValueOnce(new Error("E_OPENAPI_-461 请求总量超限"))
      .mockRejectedValueOnce(new Error("network error: ECONNRESET"))
      .mockResolvedValue({ status: 802 } as QrLoginStatus);
    await orch.beginLogin();

    expect((await orch.pollOnce()).status).toBe("waiting_scan");
    expect((await orch.pollOnce()).status).toBe("waiting_scan");
    // 第三次成功 → 计数清零，正常推进
    expect((await orch.pollOnce()).status).toBe("waiting_confirm");
    expect(orch.getFlowState()).toBe("waiting_confirm");
  });

  it("consecutive failures beyond threshold → failed", async () => {
    client.checkQrLoginStatus.mockRejectedValue(new Error("network error: ETIMEDOUT"));
    await orch.beginLogin();
    for (let i = 0; i < 4; i++) {
      expect((await orch.pollOnce()).status).toBe("waiting_scan");
    }
    expect((await orch.pollOnce()).status).toBe("failed");
    expect(orch.getFlowState()).toBe("failed");
  });

  it("pollOnce without beginLogin → failed E_NO_SESSION", async () => {
    const r = await orch.pollOnce();
    expect(r.status).toBe("failed");
    expect((r as { errorCode: string }).errorCode).toBe("E_NO_SESSION");
  });
});

describe("OpenapiLoginOrchestrator.restoreSession", () => {
  beforeEach(() => {
    client = makeClient();
    vault = makeVault();
    orch = new OpenapiLoginOrchestrator({
      client: client as unknown as NeteaseOpenapiClient,
      vault: vault as unknown as TokenVault,
    });
  });

  it("no persisted token → signed_out, returns false", async () => {
    vault.load.mockResolvedValue(null);
    expect(await orch.restoreSession()).toBe(false);
    expect(orch.getAccountState()).toBe("signed_out");
  });

  it("valid token + profile OK → signed_in, injects token", async () => {
    const blob = { formatVersion: 1 as const, provider: "netease-openapi" as const, savedAt: 1, payload: Buffer.alloc(0) };
    vault.load.mockResolvedValue(blob);
    vault.decrypt.mockResolvedValue({ accessToken: "tok", refreshToken: "rt", expireTime: 86400, gotAt: Date.now() });
    vault.isFresh.mockReturnValue(true);
    client.getUserProfile.mockResolvedValue({ nickname: "alice" });

    expect(await orch.restoreSession()).toBe(true);
    expect(client.setAccessToken).toHaveBeenCalledWith("tok");
    expect(orch.getAccountState()).toBe("signed_in");
    expect(orch.getFlowState()).toBe("authorized");
  });

  it("stale token (isFresh false) → expired", async () => {
    vault.load.mockResolvedValue({ formatVersion: 1 as const, provider: "netease-openapi" as const, savedAt: 1, payload: Buffer.alloc(0) });
    vault.decrypt.mockResolvedValue({ accessToken: "tok", refreshToken: "rt", expireTime: 86400, gotAt: 0 });
    vault.isFresh.mockReturnValue(false);
    expect(await orch.restoreSession()).toBe(false);
    expect(orch.getAccountState()).toBe("expired");
    // 失败必须清残留 token，否则后续请求带坏 token 全被 301 拒
    expect(client.setAccessToken).toHaveBeenCalledWith(null);
  });

  it("profile call fails → expired (token revoked server-side)", async () => {
    vault.load.mockResolvedValue({ formatVersion: 1 as const, provider: "netease-openapi" as const, savedAt: 1, payload: Buffer.alloc(0) });
    vault.decrypt.mockResolvedValue({ accessToken: "tok", refreshToken: "rt", expireTime: 86400, gotAt: Date.now() });
    vault.isFresh.mockReturnValue(true);
    client.getUserProfile.mockRejectedValue(new Error("401"));
    expect(await orch.restoreSession()).toBe(false);
    expect(orch.getAccountState()).toBe("expired");
    // 失败必须清残留 token，否则后续请求带坏 token 全被 301 拒
    expect(client.setAccessToken).toHaveBeenCalledWith(null);
  });

  it("corrupt blob → signed_out", async () => {
    vault.load.mockResolvedValue({ formatVersion: 1 as const, provider: "netease-openapi" as const, savedAt: 1, payload: Buffer.alloc(0) });
    vault.decrypt.mockRejectedValue(new Error("corrupt"));
    expect(await orch.restoreSession()).toBe(false);
    expect(orch.getAccountState()).toBe("signed_out");
    expect(client.setAccessToken).toHaveBeenCalledWith(null);
  });

  it("stale 'expired' account state is reset by beginLogin (QR must not be killed by renderer poll)", async () => {
    // 复现"二维码只显示几秒"的完整链路：
    // restoreSession 失败 → account=expired → 用户重新扫码 → beginLogin
    // 若不重置，渲染层轮询拿到 account=expired 会直接清二维码。
    vault.load.mockResolvedValue({ formatVersion: 1 as const, provider: "netease-openapi" as const, savedAt: 1, payload: Buffer.alloc(0) });
    vault.decrypt.mockResolvedValue({ accessToken: "tok", refreshToken: "rt", expireTime: 86400, gotAt: Date.now() });
    vault.isFresh.mockReturnValue(true);
    client.getUserProfile.mockRejectedValue(new Error("E_OPENAPI_-461"));
    await orch.restoreSession();
    expect(orch.getAccountState()).toBe("expired");

    client.loginAnonymous.mockResolvedValue({ accessToken: "anon", refreshToken: "", expireTime: 86400 });
    client.getQrCodeKey.mockResolvedValue({ qrCodeUrl: "https://163cn.tv/abc", uniKey: "k1" });
    await orch.beginLogin();

    // 登录流程进行中：账户状态不得停留在上一轮的 expired
    expect(orch.getAccountState()).toBe("signed_out");
    expect(orch.getFlowState()).toBe("waiting_scan");
  });
});
