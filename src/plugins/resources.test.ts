import { describe, expect, it, vi } from "vitest";
import { createPluginResourceTracker } from "./resources";

function recorder(events: string[], mode: "ok" | "never" | "throw" = "ok") {
  return () => {
    events.push(mode);
    if (mode === "throw") throw new Error("cleanup failed");
    if (mode === "never") return new Promise<void>(() => {});
  };
}

describe("createPluginResourceTracker", () => {
  it("dispose 按注册逆序执行清理", async () => {
    const order: string[] = [];
    const tracker = createPluginResourceTracker();
    tracker.track("tool", "a", () => order.push("a"));
    tracker.track("ipc", "b", () => order.push("b"));
    tracker.track("onDispose", "c", () => order.push("c"));
    await tracker.dispose();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("每个清理函数最多调用一次，重复 dispose 共享同一任务", async () => {
    const tracker = createPluginResourceTracker();
    const cleanup = vi.fn();
    tracker.track("tool", "a", cleanup);
    const first = tracker.dispose();
    const second = tracker.dispose();
    expect(second).toBe(first);
    await first;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("手动 release 执行清理并从跟踪器移除，之后 dispose 不再执行", async () => {
    const tracker = createPluginResourceTracker();
    const cleanup = vi.fn();
    tracker.track("tool", "a", cleanup);
    expect(await tracker.release("tool", "a")).toBe(true);
    expect(await tracker.release("tool", "a")).toBe(false);
    await tracker.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("forget 只移除登记不执行清理（调用方已自行清理）", async () => {
    const tracker = createPluginResourceTracker();
    const cleanup = vi.fn();
    tracker.track("ipc", "x", cleanup);
    expect(tracker.forget("ipc", "x")).toBe(true);
    expect(tracker.forget("ipc", "x")).toBe(false);
    await tracker.dispose();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("单项清理超时不阻止后续资源释放", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const errors: unknown[] = [];
    const tracker = createPluginResourceTracker((_kind, _key, error) => errors.push(error));
    tracker.track("tool", "a", () => order.push("a"));
    tracker.track("onDispose", "hung", recorder(order, "never"));
    tracker.track("ipc", "b", () => order.push("b"));
    tracker.track("tool", "c", () => order.push("c"));

    const disposing = tracker.dispose();
    await vi.advanceTimersByTimeAsync(6_000);
    await disposing;

    expect(order).toEqual(["c", "b", "never", "a"]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("清理超时");
    vi.useRealTimers();
  });

  it("单项清理失败被上报且不阻止其余清理", async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const tracker = createPluginResourceTracker((_kind, _key, error) => errors.push(error));
    tracker.track("tool", "a", recorder(events, "ok"));
    tracker.track("ipc", "bad", recorder(events, "throw"));
    tracker.track("onDispose", "c", recorder(events, "ok"));
    await tracker.dispose();
    expect(events).toEqual(["ok", "throw", "ok"]);
    expect(errors).toHaveLength(1);
  });

  it("dispose 后拒绝登记新资源", async () => {
    const tracker = createPluginResourceTracker();
    await tracker.dispose();
    expect(() => tracker.track("tool", "a", () => {})).toThrow(/停止后/);
  });

  it("同 kind 重复 key 拒绝登记", () => {
    const tracker = createPluginResourceTracker();
    tracker.track("tool", "a", () => {});
    expect(() => tracker.track("tool", "a", () => {})).toThrow(/已登记/);
  });
});
