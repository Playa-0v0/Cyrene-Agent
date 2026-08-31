import { describe, expect, it } from "vitest";
import {
  createReactChatSessionDispatcher,
} from "./react-chat-session-dispatcher";

describe("createReactChatSessionDispatcher", () => {
  it("初始：not ready, no pending", () => {
    const d = createReactChatSessionDispatcher();
    expect(d.isReady()).toBe(false);
    expect(d.getPending()).toBeNull();
  });

  it("未 ready 时 queueOrTake 存入 pending", () => {
    const d = createReactChatSessionDispatcher();
    expect(d.queueOrTake("A")).toBeNull();
    expect(d.getPending()).toBe("A");
  });

  it("未 ready 时连续保存 B 覆盖 A", () => {
    const d = createReactChatSessionDispatcher();
    d.queueOrTake("A");
    d.queueOrTake("B");
    expect(d.getPending()).toBe("B");
  });

  it("ready 时 queueOrTake 直接返回，不写 pending", () => {
    const d = createReactChatSessionDispatcher();
    d.markReady();
    expect(d.queueOrTake("X")).toBe("X");
    expect(d.getPending()).toBeNull();
  });

  it("ready 之后返回并清空已存在的 pending", () => {
    const d = createReactChatSessionDispatcher();
    d.queueOrTake("B");
    const flushed = d.markReady();
    expect(flushed).toBe("B");
    expect(d.getPending()).toBeNull();
  });

  it("未 ready 时 markLoading 保留 pending", () => {
    const d = createReactChatSessionDispatcher();
    expect(d.queueOrTake("X")).toBeNull();
    expect(d.getPending()).toBe("X");
    d.markLoading();
    expect(d.isReady()).toBe(false);
    expect(d.getPending()).toBe("X");
  });

  it("ready 之后再 markLoading 只重置 ready，pending 仍为 null", () => {
    const d = createReactChatSessionDispatcher();
    d.markReady();
    d.markLoading();
    expect(d.isReady()).toBe(false);
    expect(d.getPending()).toBeNull();
  });

  it("reset 清除 ready 和 pending", () => {
    // 先在未 ready 状态下让 X 进入 pending，再 reset 验证全清
    const d = createReactChatSessionDispatcher();
    expect(d.queueOrTake("X")).toBeNull();
    expect(d.getPending()).toBe("X");

    d.reset();
    expect(d.isReady()).toBe(false);
    expect(d.getPending()).toBeNull();
  });

  it("reset 后又能重新进入 pending 周期", () => {
    const d = createReactChatSessionDispatcher();
    d.markReady();
    d.queueOrTake("X");
    d.reset();
    expect(d.queueOrTake("Y")).toBeNull();
    expect(d.getPending()).toBe("Y");
  });
});
