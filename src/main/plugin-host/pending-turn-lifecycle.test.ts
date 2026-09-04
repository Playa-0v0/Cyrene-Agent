import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingTurnLifecycle, type PendingTurnInput } from "./pending-turn-lifecycle";

function makePublisher() {
  return {
    publishTurnStarted: vi.fn(),
    publishTurnFinished: vi.fn(),
    publishSchedulerFinished: vi.fn(),
  };
}

function makeInput(overrides: Partial<PendingTurnInput> = {}): PendingTurnInput {
  return {
    runId: "run-1",
    conversationId: "session-1",
    mode: "work",
    inputMessageId: "msg-user-1",
    assistantMessageId: "msg-assistant-1",
    startedAt: 0,
    runTimeoutMs: 30_000,
    ...overrides,
  };
}

describe("createPendingTurnLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("run 开始立即发布 turn:started，不发布 finished", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({
      publisher,
      now: () => 0,
      ackTimeoutMs: 60_000,
      graceMs: 60_000,
    });

    lifecycle.beginTurn(makeInput());

    expect(publisher.publishTurnStarted).toHaveBeenCalledWith({
      source: "desktop",
      runId: "run-1",
      mode: "work",
      conversationId: "session-1",
      inputMessageId: "msg-user-1",
    });
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
    expect(lifecycle.pendingCount()).toBe(1);
  });

  it("终态先到：落盘确认到达后才发布 finished 且携带 finalMessageId", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.beginTurn(makeInput());
    lifecycle.settleTerminal("run-1", { status: "success", durationMs: 1500 });
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();

    lifecycle.confirmPersistence("run-1", { finalMessageId: "msg-assistant-1" });
    expect(publisher.publishTurnFinished).toHaveBeenCalledTimes(1);
    expect(publisher.publishTurnFinished).toHaveBeenCalledWith({
      source: "desktop",
      runId: "run-1",
      mode: "work",
      conversationId: "session-1",
      inputMessageId: "msg-user-1",
      finalMessageId: "msg-assistant-1",
      status: "success",
      durationMs: 1500,
    });
    // 发布后条目清理，不留计时器
    expect(lifecycle.pendingCount()).toBe(0);
  });

  it("落盘确认先到：终态到达后立即发布一次", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.beginTurn(makeInput());
    lifecycle.confirmPersistence("run-1", { finalMessageId: "msg-assistant-1" });
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();

    lifecycle.settleTerminal("run-1", { status: "cancelled" });
    expect(publisher.publishTurnFinished).toHaveBeenCalledTimes(1);
    expect(publisher.publishTurnFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", finalMessageId: "msg-assistant-1" }),
    );
  });

  it("终态后的重复确认与重复终态都只发布一次", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.beginTurn(makeInput());
    lifecycle.settleTerminal("run-1", { status: "success" });
    lifecycle.confirmPersistence("run-1", { finalMessageId: "msg-assistant-1" });
    // 迟到的重复调用（complete/error 双路径）不得造成二次发布
    lifecycle.settleTerminal("run-1", { status: "runtime_error" });
    lifecycle.confirmPersistence("run-1", { finalMessageId: "msg-assistant-1" });

    expect(publisher.publishTurnFinished).toHaveBeenCalledTimes(1);
    expect(publisher.publishTurnFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" }),
    );
  });

  it("落盘确认缺失时 finished 不携带 finalMessageId", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.beginTurn(makeInput());
    lifecycle.settleTerminal("run-1", { status: "timeout" });
    lifecycle.confirmPersistence("run-1", {});
    expect(publisher.publishTurnFinished).toHaveBeenCalledTimes(1);
    const payload = publisher.publishTurnFinished.mock.calls[0][0] as Record<string, unknown>;
    expect("finalMessageId" in payload).toBe(false);
  });

  it("终态后 60 秒未收到落盘确认：放弃发布并清理条目", () => {
    const publisher = makePublisher();
    const onAbandon = vi.fn();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0, onAbandon });

    lifecycle.beginTurn(makeInput());
    lifecycle.settleTerminal("run-1", { status: "success" });
    vi.advanceTimersByTime(60_000);

    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
    expect(lifecycle.pendingCount()).toBe(0);
    expect(onAbandon).toHaveBeenCalledWith("run-1", "persistence ack timeout");

    // 迟到的落盘确认不复活已放弃的轮次
    lifecycle.confirmPersistence("run-1", { finalMessageId: "msg-assistant-1" });
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
  });

  it("整体期限（运行超时 + 60 秒宽限）到期时清理条目", () => {
    const publisher = makePublisher();
    const onAbandon = vi.fn();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0, onAbandon });

    // 终态一直未到：runTimeoutMs 30s + grace 60s = 90s 后整体清理
    lifecycle.beginTurn(makeInput({ runTimeoutMs: 30_000 }));
    vi.advanceTimersByTime(90_000);

    expect(lifecycle.pendingCount()).toBe(0);
    expect(onAbandon).toHaveBeenCalledWith("run-1", "lifetime expired");
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
  });

  it("disposeEntry 清理条目且不发布事件（渲染进程销毁/导航）", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.beginTurn(makeInput());
    lifecycle.disposeEntry("run-1");
    expect(lifecycle.pendingCount()).toBe(0);

    lifecycle.settleTerminal("run-1", { status: "success" });
    lifecycle.confirmPersistence("run-1", { finalMessageId: "msg-assistant-1" });
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
  });

  it("disposeAll 清理全部条目（应用关闭）", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.beginTurn(makeInput({ runId: "run-1" }));
    lifecycle.beginTurn(makeInput({ runId: "run-2", inputMessageId: "msg-user-2" }));
    lifecycle.disposeAll();

    expect(lifecycle.pendingCount()).toBe(0);
    expect(publisher.publishTurnStarted).toHaveBeenCalledTimes(2);
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
  });

  it("未知 runId 的终态/落盘确认被忽略", () => {
    const publisher = makePublisher();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0 });

    lifecycle.settleTerminal("unknown", { status: "success" });
    lifecycle.confirmPersistence("unknown", { finalMessageId: "m-1" });
    expect(lifecycle.pendingCount()).toBe(0);
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
  });

  it("缺失 inputMessageId 时整轮跳过，不发布任何事件", () => {
    const publisher = makePublisher();
    const onAbandon = vi.fn();
    const lifecycle = createPendingTurnLifecycle({ publisher, now: () => 0, onAbandon });

    lifecycle.beginTurn(makeInput({ inputMessageId: "" }));
    expect(publisher.publishTurnStarted).not.toHaveBeenCalled();
    expect(lifecycle.pendingCount()).toBe(0);
    expect(onAbandon).toHaveBeenCalledWith("run-1", "missing inputMessageId");
  });
});
