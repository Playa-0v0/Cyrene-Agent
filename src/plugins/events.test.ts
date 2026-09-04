import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginEventBus, PLUGIN_EVENT_LISTENER_TIMEOUT_MS } from "./events";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PluginEventBus 普通发布（旁路）", () => {
  it("发布函数返回时不在当前调用栈进入监听器，监听器从后续宏任务开始", async () => {
    const bus = createPluginEventBus();
    const calls: string[] = [];
    bus.on("host:chat:message", () => { calls.push("listener"); });

    const emitting = bus.emit("host:chat:message", { text: "hello" });
    expect(calls).toEqual([]);

    await emitting;
    expect(calls).toEqual(["listener"]);
  });

  it("按订阅快照顺序同步调用监听器，单个监听器抛错不影响其余", async () => {
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    const calls: string[] = [];
    bus.on("host:chat:message", () => { calls.push("first"); });
    bus.on("host:chat:message", () => { throw new Error("listener failed"); });
    bus.on("host:chat:message", () => { calls.push("third"); });

    await bus.emit("host:chat:message", { text: "hello" });

    expect(calls).toEqual(["first", "third"]);
    expect(errors).toEqual([["host:chat:message", expect.any(Error)]]);
  });

  it("慢监听器返回未决 Promise 时不阻塞发布路径", async () => {
    const bus = createPluginEventBus();
    let releaseGate: (() => void) | undefined;
    bus.on("host:chat:message", () => new Promise<void>((resolve) => { releaseGate = resolve; }));
    let emittingResolved = false;

    const emitting = bus.emit("host:chat:message", undefined).then(() => { emittingResolved = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(emittingResolved).toBe(true);
    releaseGate?.();
    await emitting;
  });

  it("异步监听器超时后记录错误并忽略迟到结果，其余监听器照常派发", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    const continued = vi.fn();
    bus.on("host:runtime:ready", () => new Promise<void>(() => {}));
    bus.on("host:runtime:ready", continued);

    const emitting = bus.emit("host:runtime:ready", undefined);
    await vi.advanceTimersByTimeAsync(PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
    await emitting;

    expect(continued).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      ["host:runtime:ready", expect.objectContaining({ message: expect.stringContaining("异步执行超时") })],
    ]);
  });

  it("异步监听器拒绝时记录错误", async () => {
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    bus.on("host:chat:message", async () => { throw new Error("async boom"); });

    await bus.emit("host:chat:message", undefined);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(errors).toEqual([
      ["host:chat:message", expect.objectContaining({ message: "async boom" })],
    ]);
  });

  it("退订函数幂等，发布使用监听器快照", async () => {
    const bus = createPluginEventBus();
    const first = vi.fn();
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    bus.on("host:runtime:ready", () => {
      first();
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.on("host:runtime:ready", second);

    await bus.emit("host:runtime:ready", undefined);
    unsubscribeSecond();
    await bus.emit("host:runtime:ready", undefined);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("PluginEventBus 生命周期屏障发布", () => {
  it("按订阅顺序等待监听器完成，并隔离单个监听器错误", async () => {
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    const received: string[] = [];
    bus.on("host:plugins:ready", async () => {
      await Promise.resolve();
      received.push("first");
    });
    bus.on("host:plugins:ready", () => {
      throw new Error("listener failed");
    });
    bus.on("host:plugins:ready", () => { received.push("third"); });

    await bus.emitLifecycleBarrier("host:plugins:ready", undefined);

    expect(received).toEqual(["first", "third"]);
    expect(errors).toEqual([["host:plugins:ready", expect.any(Error)]]);
  });

  it("屏障监听器超时后记录错误并继续后续监听器", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const bus = createPluginEventBus((event, error) => errors.push([event, error]));
    const continued = vi.fn();
    bus.on("host:plugins:stopping", () => new Promise<void>(() => {}));
    bus.on("host:plugins:stopping", continued);

    const emitting = bus.emitLifecycleBarrier("host:plugins:stopping", undefined);
    await vi.advanceTimersByTimeAsync(PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
    await emitting;

    expect(continued).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      ["host:plugins:stopping", expect.objectContaining({ message: expect.stringContaining("执行超时") })],
    ]);
  });
});

describe("PluginEventBus 事件名校验", () => {
  it("拒绝无命名空间或格式非法的事件名", async () => {
    const bus = createPluginEventBus();
    expect(() => bus.on("message", () => {})).toThrow(/事件名/);
    expect(() => bus.on("host:bad event", () => {})).toThrow(/事件名/);
    expect(() => bus.on("plugin:demo", () => {})).toThrow(/插件 id/);
    await expect(bus.emit("other:event", undefined)).rejects.toThrow(/命名空间/);
    await expect(bus.emitLifecycleBarrier("other:event", undefined)).rejects.toThrow(/命名空间/);
  });
});
