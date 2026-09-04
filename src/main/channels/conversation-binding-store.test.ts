import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelConversationBindingStore } from "./conversation-binding-store";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
}));

describe("ChannelConversationBindingStore", () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-channel-bindings-"));
    filePath = path.join(root, "context-bindings.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("coalesces timestamp writes while keeping the live list current", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const store = new ChannelConversationBindingStore(filePath);
    const chat = { sessionId: "channel:qq:a", channel: "qq" as const,
      chatId: "a", chatType: "private" as const, lastAt: 100 };
    const writes = vi.spyOn(fs, "renameSync");
    store.observe(chat);
    for (let i = 1; i <= 100; i++) {
      clock.mockReturnValue(10_000 + i * 10);
      store.observe({ ...chat, lastAt: 100 + i });
    }
    expect(store.list().externalChats[0].lastAt).toBe(200);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].lastAt).toBe(100);
    clock.mockReturnValue(15_000);
    store.observe({ ...chat, lastAt: 300 });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].lastAt).toBe(300);
  });

  it("flushes pending timestamps and keeps metadata and binding changes immediately durable", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const store = new ChannelConversationBindingStore(filePath);
    const chat = { sessionId: "channel:qq:a", channel: "qq" as const,
      chatId: "a", chatType: "private" as const, lastAt: 100 };
    store.observe(chat);
    store.observe({ ...chat, lastAt: 200 });
    store.flush();
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].lastAt).toBe(200);
    const writes = vi.spyOn(fs, "renameSync");
    store.flush();
    expect(writes).not.toHaveBeenCalled();
    store.observe({ ...chat, lastAt: 300 });
    store.bind(chat.sessionId, "desktop-1");
    expect(new ChannelConversationBindingStore(filePath).resolve(chat.sessionId)).toBe("desktop-1");
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].lastAt).toBe(300);
    store.unbind(chat.sessionId);
    expect(new ChannelConversationBindingStore(filePath).resolve(chat.sessionId)).toBeNull();
    store.observe({ ...chat, senderName: "new name", lastAt: 400 });
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].senderName).toBe("new name");
  });

  it("persists on clock rollback and retains a failed flush for retry", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const store = new ChannelConversationBindingStore(filePath);
    const chat = { sessionId: "channel:qq:a", channel: "qq" as const,
      chatId: "a", chatType: "private" as const, lastAt: 100 };
    store.observe(chat);
    clock.mockReturnValue(9_000);
    store.observe({ ...chat, lastAt: 200 });
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].lastAt).toBe(200);
    store.observe({ ...chat, lastAt: 300 });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => store.flush()).toThrow("disk unavailable");
    store.flush();
    expect(new ChannelConversationBindingStore(filePath).list().externalChats[0].lastAt).toBe(300);
  });

  it("persists a binding and resolves it after restart", () => {
    const store = new ChannelConversationBindingStore(filePath);
    store.observe({
      sessionId: "channel:wechat:aaa",
      channel: "wechat",
      chatId: "wx-user-a",
      chatType: "private",
      senderName: "Alice",
      lastAt: 100,
    });
    store.bind("channel:wechat:aaa", "conversation-1", 200);

    const restarted = new ChannelConversationBindingStore(filePath);
    expect(restarted.resolve("channel:wechat:aaa")).toBe("conversation-1");
    expect(restarted.list().bindings).toEqual([
      expect.objectContaining({
        sessionId: "channel:wechat:aaa",
        conversationId: "conversation-1",
      }),
    ]);
  });

  it("replaces an existing binding without affecting another external chat", () => {
    const store = new ChannelConversationBindingStore(filePath);
    store.observe({
      sessionId: "channel:qq:aaa",
      channel: "qq",
      chatId: "10001",
      chatType: "private",
      lastAt: 100,
    });
    store.observe({
      sessionId: "channel:qq:bbb",
      channel: "qq",
      chatId: "10002",
      chatType: "private",
      lastAt: 101,
    });
    store.bind("channel:qq:aaa", "conversation-old", 200);
    store.bind("channel:qq:bbb", "conversation-other", 201);

    store.bind("channel:qq:aaa", "conversation-new", 202);

    expect(store.resolve("channel:qq:aaa")).toBe("conversation-new");
    expect(store.resolve("channel:qq:bbb")).toBe("conversation-other");
  });

  it("rejects bindings for an external chat that has not been observed", () => {
    const store = new ChannelConversationBindingStore(filePath);

    expect(() => store.bind("channel:qq:unknown", "conversation-1")).toThrow(
      "Unknown external chat",
    );
  });

  it("unbind removes only the selected external chat binding", () => {
    const store = new ChannelConversationBindingStore(filePath);
    for (const [sessionId, chatId] of [
      ["channel:feishu:aaa", "oc_a"],
      ["channel:feishu:bbb", "oc_b"],
    ] as const) {
      store.observe({ sessionId, channel: "feishu", chatId, chatType: "private", lastAt: 100 });
      store.bind(sessionId, `conversation-${chatId}`);
    }

    expect(store.unbind("channel:feishu:aaa")).toBe(true);
    expect(store.resolve("channel:feishu:aaa")).toBeNull();
    expect(store.resolve("channel:feishu:bbb")).toBe("conversation-oc_b");
  });

  it("treats malformed persisted data as empty", () => {
    fs.writeFileSync(filePath, "{not json", "utf8");

    const store = new ChannelConversationBindingStore(filePath);

    expect(store.list()).toEqual({ externalChats: [], bindings: [] });
    expect(store.resolve("channel:wechat:aaa")).toBeNull();
  });

  it("keeps only the most recently observed external chats", () => {
    const store = new ChannelConversationBindingStore(filePath, 2);
    store.observe({
      sessionId: "channel:qq:first",
      channel: "qq",
      chatId: "1",
      chatType: "private",
      lastAt: 1,
    });
    store.observe({
      sessionId: "channel:qq:second",
      channel: "qq",
      chatId: "2",
      chatType: "private",
      lastAt: 2,
    });
    store.observe({
      sessionId: "channel:qq:third",
      channel: "qq",
      chatId: "3",
      chatType: "private",
      lastAt: 3,
    });

    expect(store.list().externalChats.map((chat) => chat.chatId)).toEqual(["3", "2"]);
    expect(store.resolve("channel:qq:first")).toBeNull();
  });

  it("keeps a bound chat even when newer unbound chats exceed the collection limit", () => {
    const store = new ChannelConversationBindingStore(filePath, 2);
    store.observe({
      sessionId: "channel:qq:bound",
      channel: "qq",
      chatId: "bound",
      chatType: "private",
      lastAt: 1,
    });
    store.bind("channel:qq:bound", "conversation-bound");
    store.observe({
      sessionId: "channel:qq:newer-1",
      channel: "qq",
      chatId: "newer-1",
      chatType: "private",
      lastAt: 2,
    });
    store.observe({
      sessionId: "channel:qq:newer-2",
      channel: "qq",
      chatId: "newer-2",
      chatType: "private",
      lastAt: 3,
    });

    expect(store.resolve("channel:qq:bound")).toBe("conversation-bound");
    expect(store.list().externalChats.map((chat) => chat.chatId)).toEqual(["newer-2", "bound"]);
  });

  it("does not evict bound chats after restarting when the bound count exceeds the display limit", () => {
    const store = new ChannelConversationBindingStore(filePath, 2);
    for (const [sessionId, chatId] of [
      ["channel:qq:bound-a", "bound-a"],
      ["channel:qq:bound-b", "bound-b"],
    ] as const) {
      store.observe({ sessionId, channel: "qq", chatId, chatType: "private", lastAt: 1 });
      store.bind(sessionId, `conversation-${chatId}`);
    }

    const restarted = new ChannelConversationBindingStore(filePath, 1);
    expect(restarted.resolve("channel:qq:bound-a")).toBe("conversation-bound-a");
    expect(restarted.resolve("channel:qq:bound-b")).toBe("conversation-bound-b");
    expect(restarted.list().externalChats.map((chat) => chat.chatId).sort()).toEqual(["bound-a", "bound-b"]);
  });
});
