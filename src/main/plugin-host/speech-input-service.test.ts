import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createActiveChatTargetRegistry,
} from "./active-chat-target";
import {
  createSpeechInputService,
  type FrozenSpeechInputTarget,
  type SpeechInputLeaseOwner,
} from "./speech-input-service";
import { createPluginResourceTracker } from "../../plugins/resources";

/** 模拟聊天窗口的 webContents：EventEmitter 提供 on/once/removeListener/isDestroyed。 */
function fakeWebContents(id: number) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    id,
    isDestroyed: () => false,
  }) as unknown as import("electron").WebContents & EventEmitter;
}

function emitNavigation(wc: EventEmitter, isMainFrame = true): void {
  wc.emit("did-start-navigation", {}, "https://localhost/", false, isMainFrame, 1, 1);
}

function setup() {
  const registry = createActiveChatTargetRegistry();
  const wc = fakeWebContents(7);
  // 内存会话存储：s1/s2 存在，其余视为已删除
  const sessions = new Set(["s1", "s2"]);
  // 提交桥记录收到的冻结目标与文本
  const commits: Array<{ target: FrozenSpeechInputTarget; text: string }> = [];
  const bridge = {
    commit: vi.fn(async (target: FrozenSpeechInputTarget, text: string) => {
      commits.push({ target: { ...target }, text });
    }),
  };
  const service = createSpeechInputService({
    registry,
    sessionStore: { getSession: (id: string) => (sessions.has(id) ? { id } : null) },
    commitBridge: bridge,
  });

  function register(sessionId: string, rendererTargetId = "rt-1"): void {
    registry.setActive({ sender: wc, sessionId, mode: "chat", rendererTargetId });
  }

  function makeOwner(pluginId: string) {
    const controller = new AbortController();
    const tracker = createPluginResourceTracker();
    const owner: SpeechInputLeaseOwner = { pluginId, signal: controller.signal, tracker };
    return { owner, controller, tracker };
  }

  return { registry, wc, sessions, bridge, commits, service, register, makeOwner };
}

function expectHostError(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe("createSpeechInputService.acquire", () => {
  it("两个插件争抢租约只有一个成功，第二个收到 E_SPEECH_INPUT_BUSY", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const b = ctx.makeOwner("plugin-b");
    await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    await expectHostError(
      ctx.service.acquireForPlugin(b.owner, { target: "active-chat" }),
      "E_SPEECH_INPUT_BUSY",
    );
  });

  it("没有活动目标返回 E_NO_ACTIVE_INPUT_TARGET", async () => {
    const ctx = setup();
    const a = ctx.makeOwner("plugin-a");
    await expectHostError(
      ctx.service.acquireForPlugin(a.owner, { target: "active-chat" }),
      "E_NO_ACTIVE_INPUT_TARGET",
    );
  });

  it("active-call 目标当前版本返回 E_CAPABILITY_UNAVAILABLE，非法目标返回 E_INVALID_ARGUMENT", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    await expectHostError(
      ctx.service.acquireForPlugin(a.owner, { target: "active-call" }),
      "E_CAPABILITY_UNAVAILABLE",
    );
    await expectHostError(
      ctx.service.acquireForPlugin(a.owner, { target: "nowhere" as never }),
      "E_INVALID_ARGUMENT",
    );
  });

  it("插件已停止时 acquire 返回 E_PLUGIN_STOPPING", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    a.controller.abort();
    await expectHostError(
      ctx.service.acquireForPlugin(a.owner, { target: "active-chat" }),
      "E_PLUGIN_STOPPING",
    );
  });
});

describe("createSpeechInputService 租约冻结与失效", () => {
  it("A 会话取得租约后页面切到 B，commit 仍提交到 A 的冻结目标", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    // 同页面切换到会话 B（rendererTargetId 不变）
    ctx.register("s2");
    await lease.commit("你好");
    expect(ctx.commits).toHaveLength(1);
    expect(ctx.commits[0].target.sessionId).toBe("s1");
    expect(ctx.commits[0].text).toBe("你好");
    expect(lease.signal.aborted).toBe(false);
  });

  it("页面主框架导航使租约中止：signal 触发，后续 commit 返回 E_NOT_FOUND", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    emitNavigation(ctx.wc, true);
    expect(lease.signal.aborted).toBe(true);
    await expectHostError(lease.commit("你好"), "E_NOT_FOUND");
    // 租约中止后全局占用腾出，其他插件可取得
    ctx.register("s1", "rt-2");
    const b = ctx.makeOwner("plugin-b");
    await expect(
      ctx.service.acquireForPlugin(b.owner, { target: "active-chat" }),
    ).resolves.toBeTruthy();
  });

  it("子框架导航不影响租约", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    emitNavigation(ctx.wc, false);
    expect(lease.signal.aborted).toBe(false);
    await lease.commit("你好");
    expect(ctx.commits).toHaveLength(1);
  });

  it("冻结会话被删除时租约中止，即使页面已切到其他会话", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    ctx.register("s2");
    ctx.sessions.delete("s1");
    ctx.registry.notifySessionDeleted("s1");
    expect(lease.signal.aborted).toBe(true);
    await expectHostError(lease.commit("你好"), "E_NOT_FOUND");
  });

  it("commit 时冻结会话已从存储删除返回 E_NOT_FOUND", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    // 只从存储删除，不触发登记表通知（模拟删除路径遗漏）
    ctx.sessions.delete("s1");
    await expectHostError(lease.commit("你好"), "E_NOT_FOUND");
    expect(ctx.commits).toHaveLength(0);
  });
});

describe("createSpeechInputService.release 与插件停止", () => {
  it("重复 release 无副作用，release 后 commit 返回 E_NOT_FOUND", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    await lease.release();
    await lease.release();
    expect(lease.signal.aborted).toBe(true);
    await expectHostError(lease.commit("你好"), "E_NOT_FOUND");
  });

  it("插件停止信号触发租约释放并腾出全局占用", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    a.controller.abort();
    expect(lease.signal.aborted).toBe(true);
    const b = ctx.makeOwner("plugin-b");
    await expect(
      ctx.service.acquireForPlugin(b.owner, { target: "active-chat" }),
    ).resolves.toBeTruthy();
  });

  it("资源跟踪器 dispose（激活回滚/插件停止清理）走同一释放路径", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    await a.tracker.dispose();
    expect(lease.signal.aborted).toBe(true);
    const b = ctx.makeOwner("plugin-b");
    await expect(
      ctx.service.acquireForPlugin(b.owner, { target: "active-chat" }),
    ).resolves.toBeTruthy();
  });

  it("service.dispose 释放当前租约并退订登记表监听", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    ctx.service.dispose();
    expect(lease.signal.aborted).toBe(true);
    // dispose 后再 acquire 一律拒绝
    await expectHostError(
      ctx.service.acquireForPlugin(a.owner, { target: "active-chat" }),
      "E_PLUGIN_STOPPING",
    );
  });
});

describe("createSpeechInputService.commit", () => {
  it("空文本返回 E_INVALID_ARGUMENT", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    await expectHostError(lease.commit(""), "E_INVALID_ARGUMENT");
    await expectHostError(lease.commit("   "), "E_INVALID_ARGUMENT");
  });

  it("插件停止后 commit 返回 E_PLUGIN_STOPPING", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    a.controller.abort();
    await expectHostError(lease.commit("你好"), "E_PLUGIN_STOPPING");
  });

  it("同一租约多次 commit 串行执行：慢的先完成，快的后开始", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    const order: string[] = [];
    ctx.bridge.commit.mockImplementation(async (_t, text: string) => {
      if (text === "慢") await new Promise((r) => setTimeout(r, 30));
      order.push(text);
    });
    await Promise.all([lease.commit("慢"), lease.commit("快")]);
    expect(order).toEqual(["慢", "快"]);
  });

  it("前一次 commit 失败不阻断后续提交", async () => {
    const ctx = setup();
    ctx.register("s1");
    const a = ctx.makeOwner("plugin-a");
    const lease = await ctx.service.acquireForPlugin(a.owner, { target: "active-chat" });
    const order: string[] = [];
    let shouldFail = true;
    ctx.bridge.commit.mockImplementation(async (_t, text: string) => {
      if (shouldFail && text === "失败") throw new Error("桥异常");
      order.push(text);
    });
    await expect(lease.commit("失败")).rejects.toThrow("桥异常");
    shouldFail = false;
    await lease.commit("成功");
    expect(order).toEqual(["成功"]);
  });
});
