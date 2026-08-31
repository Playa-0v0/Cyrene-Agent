// OpenAPI QR login orchestrator (M2 rewrite).
//
// Replaces the weapi/Python QR flow with direct OpenAPI QR endpoints:
//   1. loginAnonymous() → anon token (QR endpoints require it)
//   2. getQrCodeKey()   → { qrCodeUrl, uniKey }  (300s validity)
//   3. checkQrLoginStatus(uniKey) → 800/801/802/803
//   4. On 803: persist { accessToken, refreshToken, expireTime } → TokenVault
//
// State machine preserved: idle/creating_qr/waiting_scan/waiting_confirm/
// authorized/expired/cancelled/failed.  Renderer reads `qrContent` only —
// field name kept for compatibility (panel.ts:177).
//
// Coexists with the old LoginOrchestrator until M3 swaps MusicService over.
import type { NeteaseOpenapiClient, OpenapiTokenBundle, QrLoginStatus } from "./netease-openapi-client";
import type { TokenVault } from "./token-vault";
import type { LoginFlowState, MusicAccountState } from "./types";

export interface LoginOrchestratorDeps {
  client: NeteaseOpenapiClient;
  vault: TokenVault;
  /** QR validity window (server default 300s via expiredKey). */
  qrValidityMs?: number;
  /** Poll cadence (PoC: 3s). */
  pollIntervalMs?: number;
}

export type BeginResult =
  | { uniKey: string; qrContent: string; expiresAt: number; pollIntervalMs: number }
  | { status: "login_already_active"; activeSessionId: string };

export type CheckResult =
  | { status: "waiting_scan" }
  | { status: "waiting_confirm" }
  | { status: "authorized"; credentialsPersisted: boolean; profile: { userId: string; nickname: string } }
  | { status: "expired"; errorCode?: string }
  | { status: "cancelled" }
  | { status: "failed"; errorCode?: string };

const TERMINAL: ReadonlyArray<CheckResult["status"]> = ["authorized", "expired", "cancelled", "failed"];

/**
 * 瞬时错误容忍：checkQrLoginStatus 单次失败（网络抖动 / -461 配额限流）就
 * 把流程打成 failed 会让 UI 立即清掉二维码——用户看到"二维码只显示几秒"。
 * 连续失败达到该阈值才真正判死；期间保持 waiting 状态继续轮询。
 */
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

export class OpenapiLoginOrchestrator {
  private flowState: LoginFlowState = "idle";
  private accountState: MusicAccountState = "unknown";
  private uniKey: string | null = null;
  private qrExpiresAt = 0;
  /** 当前会话的二维码内容（复用旧码时返回给渲染层重新渲染）。 */
  private lastQrContent: string | null = null;
  private persisted = false;
  private inFlightCheck = false;
  /** 连续轮询失败计数（成功即清零）。达到阈值才判 failed。 */
  private consecutivePollErrors = 0;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: LoginOrchestratorDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
  }

  getFlowState(): LoginFlowState {
    return this.flowState;
  }

  getAccountState(): MusicAccountState {
    return this.accountState;
  }

  setAccountState(s: MusicAccountState): void {
    this.accountState = s;
  }

  async beginLogin(): Promise<BeginResult> {
    // 旧会话的 expired / temporarily_unavailable 是对上一个 token 的结论，
    // 不是对本次扫码流程的结论。不重置的话，渲染层轮询（panel.ts 的
    // account === "expired" 分支）会在第一次 getStatus 就把二维码清掉
    // ——用户看到"二维码只显示几秒"，但服务器端 300 秒有效期根本没用完。
    if (this.accountState === "expired" || this.accountState === "temporarily_unavailable") {
      this.accountState = "signed_out";
    }

    // 孤儿会话回收：上一轮登录流未终结（典型：用户离开设置面板 → 轮询停止，
    // 但会话还留在内存里）。直接返回 login_already_active 会把扫码入口卡死——
    // 渲染层拿不到 qrContent 画不出二维码，也不再轮询，手机上已完成的授权永远
    // 收不到。所以先向服务器探一次真实状态再决定：
    //   803 → 吃掉已完成的授权（用户不用重扫）
    //   801/802 → 旧码仍在有效期，复用同一张二维码
    //   800/failed → 作废旧会话，重新生成
    if (this.uniKey && !TERMINAL.includes(this.flowState as CheckResult["status"])) {
      const check = await this.pollOnce();
      if (check.status === "authorized") {
        this.uniKey = null;
        this.lastQrContent = null;
        return { status: "login_already_active", activeSessionId: "" };
      }
      if (check.status === "waiting_scan" || check.status === "waiting_confirm") {
        return {
          uniKey: this.uniKey,
          qrContent: this.lastQrContent ?? "",
          expiresAt: this.qrExpiresAt,
          pollIntervalMs: this.pollIntervalMs,
        };
      }
      this.uniKey = null;
      this.lastQrContent = null;
    }

    this.flowState = "creating_qr";
    this.persisted = false;
    this.consecutivePollErrors = 0;

    // QR endpoints require an anonymous token even when a user token exists.
    const anon: OpenapiTokenBundle = await this.deps.client.loginAnonymous();
    this.deps.client.setAccessToken(anon.accessToken);

    const qr = await this.deps.client.getQrCodeKey();
    this.uniKey = qr.uniKey;
    this.lastQrContent = qr.qrCodeUrl;
    const validityMs = this.deps.qrValidityMs ?? 300_000;
    this.qrExpiresAt = Date.now() + validityMs;
    this.flowState = "waiting_scan";

    return {
      uniKey: qr.uniKey,
      qrContent: qr.qrCodeUrl,
      expiresAt: this.qrExpiresAt,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  async pollOnce(): Promise<CheckResult> {
    if (!this.uniKey) return { status: "failed", errorCode: "E_NO_SESSION" };

    // Terminal states are idempotent — return the cached result.
    if (this.flowState === "authorized") {
      return { status: "authorized", credentialsPersisted: this.persisted, profile: { userId: "", nickname: "" } };
    }
    if (this.flowState === "expired") return { status: "expired" };
    if (this.flowState === "cancelled") return { status: "cancelled" };
    if (this.flowState === "failed") return { status: "failed" };

    // Local expiry guard (server 800 may lag).
    if (Date.now() >= this.qrExpiresAt) {
      this.flowState = "expired";
      return { status: "expired", errorCode: "E_QR_EXPIRED_LOCAL" };
    }

    if (this.inFlightCheck) {
      // 上一次请求还没回来（网络慢于轮询间隔）→ 不是失败，保持等待态。
      // 返回 failed 会让 UI 清掉二维码（"二维码只显示几秒"的帮凶之一）。
      return this.waitingResult();
    }
    this.inFlightCheck = true;
    try {
      const raw = await this.deps.client.checkQrLoginStatus(this.uniKey);
      this.consecutivePollErrors = 0;
      return this.applyQrStatus(raw);
    } catch (e: unknown) {
      // 瞬时错误容忍：网络抖动 / -461 配额限流只计数，不判死。
      // 连续超过阈值才 failed；期间二维码继续显示、轮询继续。
      this.consecutivePollErrors++;
      const message = (e as Error).message.slice(0, 120);
      if (this.consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        this.flowState = "failed";
        return { status: "failed", errorCode: message };
      }
      console.warn(
        `[music] QR poll transient error (${this.consecutivePollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}):`,
        message,
      );
      return this.waitingResult();
    } finally {
      this.inFlightCheck = false;
    }
  }

  /** 当前等待态的应答（保留 waiting_confirm 语义，供 UI 显示"已扫码待确认"）。 */
  private waitingResult(): CheckResult {
    return this.flowState === "waiting_confirm"
      ? { status: "waiting_confirm" }
      : { status: "waiting_scan" };
  }

  async cancelLogin(): Promise<void> {
    if (!this.uniKey) return;
    // Late cancel must not overwrite success.
    if (this.flowState === "authorized") return;
    // No server-side cancel endpoint (manifest has none); QR auto-expires in 300s.
    this.flowState = "cancelled";
  }

  async shutdown(): Promise<void> {
    if (!TERMINAL.includes(this.flowState as CheckResult["status"])) {
      await this.cancelLogin();
    }
  }

  /**
   * Startup restore: load persisted token from TokenVault, inject into client,
   * validate by calling getUserProfile. Called once at MusicService boot.
   * Returns true when the session is valid and the client is ready for
   * user-level endpoint calls.
   */
  async restoreSession(): Promise<boolean> {
    const blob = await this.deps.vault.load();
    if (!blob) {
      console.log("[music] restoreSession: 无已保存 token");
      this.accountState = "signed_out";
      return false;
    }
    let bundle;
    try {
      bundle = await this.deps.vault.decrypt(blob);
    } catch (err) {
      console.warn("[music] restoreSession: token 解密失败，按未登录处理", err instanceof Error ? err.message : err);
      this.deps.client.setAccessToken(null);
      this.accountState = "signed_out";
      return false;
    }
    if (!this.deps.vault.isFresh(bundle)) {
      console.log("[music] restoreSession: token 已过期，需要重新登录");
      this.deps.client.setAccessToken(null);
      this.accountState = "expired";
      return false;
    }
    this.deps.client.setAccessToken(bundle.accessToken);
    try {
      await this.deps.client.getUserProfile();
      console.log("[music] restoreSession: token 有效，已恢复登录态");
      this.accountState = "signed_in";
      this.flowState = "authorized";
      this.persisted = true;
      return true;
    } catch (err) {
      console.warn("[music] restoreSession: token 验证失败（getUserProfile），按过期处理", err instanceof Error ? err.message : err);
      // 关键：验证失败必须清掉 client 里的失效 token，否则后续所有业务请求
      // 都带着坏 token 被 301 拒绝（包括重新扫码时的匿名登录入口）。
      this.deps.client.setAccessToken(null);
      this.accountState = "expired";
      return false;
    }
  }

  private applyQrStatus(raw: QrLoginStatus): CheckResult {
    switch (raw.status) {
      case 801:
        this.flowState = "waiting_scan";
        return { status: "waiting_scan" };
      case 802:
        this.flowState = "waiting_confirm";
        return { status: "waiting_confirm" };
      case 800:
        this.flowState = "expired";
        return { status: "expired", errorCode: raw.msg ?? "E_QR_EXPIRED" };
      case 803: {
        this.flowState = "authorized";
        this.accountState = "signed_in";
        const token = raw.accessToken;
        this.deps.client.setAccessToken(token.accessToken);
        if (!this.persisted) {
          this.persisted = true;
          // Fire-and-forget: caller (renderer) doesn't wait on disk I/O.
          void this.deps.vault.persist({
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expireTime: token.expireTime,
            gotAt: Date.now(),
          });
        }
        return { status: "authorized", credentialsPersisted: this.persisted, profile: { userId: "", nickname: "" } };
      }
      default:
        this.flowState = "failed";
        return { status: "failed", errorCode: `E_UNKNOWN_QR_STATUS_${(raw as { status: number }).status}` };
    }
  }
}
