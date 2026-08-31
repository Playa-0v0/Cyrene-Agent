import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { OneBotResponse, OneBotStreamPacket } from "./onebot-types";

interface PendingAction {
  mode: "single" | "stream";
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  onPacket?: (packet: OneBotStreamPacket) => void | Promise<void>;
  packetChain: Promise<void>;
  terminalReceived: boolean;
  /** 流回调抛出的首个错误；接链时捕获，terminal 包到达时统一 reject，避免 rejected promise 无人处理导致 unhandledRejection 崩溃主进程。 */
  packetError?: Error;
}

export class OneBotActionError extends Error {
  constructor(
    message: string,
    readonly retcode?: number,
  ) {
    super(message);
    this.name = "OneBotActionError";
  }
}

export class OneBotActionClient {
  private pending = new Map<string, PendingAction>();

  constructor(
    private readonly socket: WebSocket,
    private readonly normalTimeoutMs = 30_000,
    private readonly streamTimeoutMs = 10 * 60_000,
  ) {}

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = this.normalTimeoutMs): Promise<T> {
    return this.sendRequest<T>(action, params, "single", timeoutMs);
  }

  callStream<T = OneBotStreamPacket>(
    action: string,
    params: Record<string, unknown>,
    onPacket: (packet: OneBotStreamPacket) => void | Promise<void>,
    timeoutMs = this.streamTimeoutMs,
  ): Promise<T> {
    return this.sendRequest<T>(action, params, "stream", timeoutMs, onPacket);
  }

  handleResponse(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const response = value as OneBotResponse<unknown>;
    if (typeof response.echo !== "string") return false;
    const pending = this.pending.get(response.echo);
    if (!pending) return false;

    if (response.status === "failed" || response.retcode !== 0) {
      this.finish(response.echo);
      pending.reject(new OneBotActionError(
        response.wording || response.message || `OneBot action failed (${response.retcode})`,
        response.retcode,
      ));
      return true;
    }

    if (pending.mode === "single") {
      this.finish(response.echo);
      pending.resolve(response.data);
      return true;
    }
    if (pending.terminalReceived) return true;

    const packet = response.data as OneBotStreamPacket;
    // 接链时捕获回调异常：NapCat 不会因客户端回调失败而停发后续包，
    // 若不在链上兜底，每个后续包都会产生一个无 handler 的 rejected promise（unhandledRejection → 主进程崩溃）。
    pending.packetChain = pending.packetChain
      .then(() => pending.onPacket?.(packet))
      .catch((error) => {
        pending.packetError ??= error instanceof Error ? error : new Error(String(error));
      });
    if (packet?.type === "response") {
      pending.terminalReceived = true;
      void pending.packetChain.then(() => {
        this.finish(response.echo!);
        if (pending.packetError) pending.reject(pending.packetError);
        else pending.resolve(packet);
      });
    } else if (packet?.type === "error" || packet?.type === "reset") {
      pending.terminalReceived = true;
      void pending.packetChain.then(() => {
        this.finish(response.echo!);
        if (pending.packetError) pending.reject(pending.packetError);
        else pending.reject(new OneBotActionError(`OneBot stream ${packet.type}`));
      });
    }
    return true;
  }

  rejectAll(reason = "OneBot connection closed"): void {
    for (const [echo, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(echo);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private sendRequest<T>(
    action: string,
    params: Record<string, unknown>,
    mode: PendingAction["mode"],
    timeoutMs: number,
    onPacket?: PendingAction["onPacket"],
  ): Promise<T> {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new Error("OneBot WebSocket is not open"));
    }
    const echo = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        mode,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        onPacket,
        packetChain: Promise.resolve(),
        terminalReceived: false,
      });
      try {
        this.socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        this.finish(echo);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private finish(echo: string): void {
    const pending = this.pending.get(echo);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(echo);
  }
}
