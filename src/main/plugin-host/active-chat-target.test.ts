import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createActiveChatTargetRegistry,
  generateRendererTargetId,
  parseActiveTargetPayload,
} from "./active-chat-target";

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

describe("createActiveChatTargetRegistry", () => {
  it("登记活动目标并返回快照（拷贝，不受后续切换影响）", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });

    const frozen = registry.getActive();
    expect(frozen).toEqual({ sessionId: "s1", mode: "chat", rendererTargetId: "rt-1", webContentsId: 7 });

    registry.setActive({ sender: wc, sessionId: "s2", mode: "work", rendererTargetId: "rt-1" });
    expect(frozen?.sessionId).toBe("s1");
    expect(registry.getActive()?.sessionId).toBe("s2");
  });

  it("同一页面切换会话不触发失效；rendererTargetId 保持不变", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    const onInvalidated = vi.fn();
    registry.onInvalidated(onInvalidated);

    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });
    registry.setActive({ sender: wc, sessionId: "s2", mode: "chat", rendererTargetId: "rt-1" });

    expect(onInvalidated).not.toHaveBeenCalled();
    expect(registry.getActive()?.rendererTargetId).toBe("rt-1");
  });

  it("主框架导航使目标失效并通知监听方；子框架导航不失效", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    const onInvalidated = vi.fn();
    registry.onInvalidated(onInvalidated);
    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });

    emitNavigation(wc, false);
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(registry.getActive()).not.toBeNull();

    emitNavigation(wc, true);
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(onInvalidated).toHaveBeenCalledWith(
      "navigation",
      expect.objectContaining({ sessionId: "s1", rendererTargetId: "rt-1" }),
    );
    expect(registry.getActive()).toBeNull();
  });

  it("webContents 销毁使目标失效", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    const onInvalidated = vi.fn();
    registry.onInvalidated(onInvalidated);
    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });

    wc.emit("destroyed");
    expect(onInvalidated).toHaveBeenCalledWith("target-destroyed", expect.objectContaining({ sessionId: "s1" }));
    expect(registry.getActive()).toBeNull();
  });

  it("删除当前目标会话使目标失效；删除其他会话不影响", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    const onInvalidated = vi.fn();
    registry.onInvalidated(onInvalidated);
    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });

    registry.notifySessionDeleted("other");
    expect(onInvalidated).not.toHaveBeenCalled();

    registry.notifySessionDeleted("s1");
    expect(onInvalidated).toHaveBeenCalledWith("session-deleted", expect.objectContaining({ sessionId: "s1" }));
    expect(registry.getActive()).toBeNull();
  });

  it("会话删除监听对任意会话触发：页面已切到其他会话时仍通知旧会话删除", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    const onSessionDeleted = vi.fn();
    registry.onSessionDeleted(onSessionDeleted);
    // 租约冻结 s1 后页面切换到 s2（rendererTargetId 不变）
    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });
    registry.setActive({ sender: wc, sessionId: "s2", mode: "chat", rendererTargetId: "rt-1" });

    registry.notifySessionDeleted("s1");
    expect(onSessionDeleted).toHaveBeenCalledWith("s1");

    // 当前目标仍是 s2，未因删除 s1 失效
    expect(registry.getActive()?.sessionId).toBe("s2");
  });

  it("clearActive 只清空同一 webContents 的目标", () => {
    const registry = createActiveChatTargetRegistry();
    const wcA = fakeWebContents(7);
    const wcB = fakeWebContents(9);
    registry.setActive({ sender: wcA, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });

    registry.clearActive(wcB);
    expect(registry.getActive()).not.toBeNull();

    registry.clearActive(wcA);
    expect(registry.getActive()).toBeNull();
  });

  it("页面重新加载后新 webContents 登记会切换失效监听，旧页面导航不再影响新目标", () => {
    const registry = createActiveChatTargetRegistry();
    const oldWc = fakeWebContents(7);
    const newWc = fakeWebContents(8);
    const onInvalidated = vi.fn();
    registry.onInvalidated(onInvalidated);

    registry.setActive({ sender: oldWc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });
    registry.setActive({ sender: newWc, sessionId: "s2", mode: "chat", rendererTargetId: "rt-2" });

    // 旧页面迟到的导航事件不再影响新目标
    emitNavigation(oldWc, true);
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(registry.getActive()?.sessionId).toBe("s2");

    // 新页面自己的导航才失效
    emitNavigation(newWc, true);
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再接受登记且通知监听器被清空", () => {
    const registry = createActiveChatTargetRegistry();
    const wc = fakeWebContents(7);
    const onInvalidated = vi.fn();
    registry.onInvalidated(onInvalidated);
    registry.setActive({ sender: wc, sessionId: "s1", mode: "chat", rendererTargetId: "rt-1" });

    registry.dispose();
    expect(registry.getActive()).toBeNull();

    registry.setActive({ sender: wc, sessionId: "s2", mode: "chat", rendererTargetId: "rt-2" });
    wc.emit("destroyed");
    expect(onInvalidated).not.toHaveBeenCalled();
  });
});

describe("parseActiveTargetPayload", () => {
  it("接受合法负载", () => {
    expect(parseActiveTargetPayload({ sessionId: "s1", mode: "work", rendererTargetId: "rt-1" }))
      .toEqual({ sessionId: "s1", mode: "work", rendererTargetId: "rt-1" });
  });

  it("拒绝缺失或类型错误的字段", () => {
    expect(parseActiveTargetPayload(null)).toBeNull();
    expect(parseActiveTargetPayload("s1")).toBeNull();
    expect(parseActiveTargetPayload({ sessionId: "", mode: "chat", rendererTargetId: "rt" })).toBeNull();
    expect(parseActiveTargetPayload({ sessionId: "s1", mode: "invalid", rendererTargetId: "rt" })).toBeNull();
    expect(parseActiveTargetPayload({ sessionId: "s1", mode: "chat", rendererTargetId: "" })).toBeNull();
  });
});

describe("generateRendererTargetId", () => {
  it("每次生成不同标识", () => {
    expect(generateRendererTargetId()).not.toBe(generateRendererTargetId());
  });
});
