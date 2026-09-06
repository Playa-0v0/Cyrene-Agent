// dispatcher 核心单元测试：sessionId hash + 限速
import * as os from "node:os";
import { describe, it, expect, vi } from "vitest";
import { ChannelDispatcher, formatChannelUserText, makeSessionId, lookupOriginalSender } from "./dispatcher";
import type { IncomingMessage } from "./types";

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => process.cwd(),
    getName: () => "Cyrene",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

vi.mock("./message-log", () => ({
  appendLog: vi.fn(),
  reloadLogFromDisk: vi.fn(),
}));

vi.mock("./history-log", () => ({
  appendHistory: vi.fn(),
  migrateHistory: vi.fn(),
}));

describe("channels/dispatcher", () => {
  it("makeSessionId: 同 channel + 同 sender → 同 sessionId", () => {
    const a = makeSessionId("feishu", "ou_abc123");
    const b = makeSessionId("feishu", "ou_abc123");
    expect(a).toBe(b);
  });

  it("makeSessionId: 跨 channel 不同 sessionId", () => {
    const f = makeSessionId("feishu", "user-x");
    const w = makeSessionId("wechat", "user-x");
    expect(f).not.toBe(w);
  });

  it("makeSessionId: 长度 16 字符 hash + 前缀", () => {
    const s = makeSessionId("feishu", "ou_abc");
    // 格式: channel:<channel>:<16 hex>
    expect(s).toMatch(/^channel:feishu:[0-9a-f]{16}$/);
  });

  it("makeSessionId: 不同 sender → 不同 sessionId", () => {
    const a = makeSessionId("feishu", "ou_aaa");
    const b = makeSessionId("feishu", "ou_bbb");
    expect(a).not.toBe(b);
  });

  it("lookupOriginalSender: 未知 sessionId 返回 null", () => {
    expect(lookupOriginalSender("channel:feishu:0000000000000000")).toBeNull();
  });

  it("uses a shared QQ group chat id while preserving sender identity in agent text", () => {
    expect(makeSessionId("qq", "20001")).toBe(makeSessionId("qq", "20001"));
    expect(formatChannelUserText({
      channel: "qq",
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "你好",
      at: new Date(0),
    })).toBe("[群聊发送者：小明 (10001)]\n你好");
  });

  it("isolates QQ private sessions by user id", () => {
    expect(makeSessionId("qq", "10001")).not.toBe(makeSessionId("qq", "10002"));
  });

  function makeIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      channel: "qq",
      chatType: "private",
      senderId: "user-1",
      senderName: "测试用户",
      chatId: "chat-1",
      text: "你好",
      at: new Date(0),
      ...overrides,
    };
  }

  function makeManager() {
    return { getAdapter: () => ({ capability: { text: true, image: true, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 4000 } }) } as any;
  }

  it("uses channel history and channel session when the chat is unbound", async () => {
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道旧消息" }]);
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(makeSessionId("qq", "chat-1"));
      expect(prior).toEqual([{ role: "user", content: "渠道旧消息" }]);
      return { text: "渠道回复", sticker: null };
    });
    const dispatcher = new ChannelDispatcher({ manager: makeManager(), loadRecentChannelHistory, buildAndRunAgent });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).toHaveBeenCalledWith(makeSessionId("qq", "chat-1"), 16);
    expect(buildAndRunAgent).toHaveBeenCalledOnce();
  });

  it.each(["qq", "wechat"] as const)("uses bound desktop history while keeping %s runtime identity separate", async (channel) => {
    const channelSessionId = makeSessionId(channel, "chat-1");
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "不应读取" }]);
    const loadBoundConversationHistory = vi.fn(async (conversationId: string, limit: number) => {
      expect(conversationId).toBe("conversation-7");
      expect(limit).toBe(16);
      return [{ role: "user" as const, content: "桌面旧消息" }];
    });
    const appendBoundConversationMessage = vi.fn();
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(channelSessionId);
      expect(prior).toEqual([{ role: "user", content: "桌面旧消息" }]);
      return { text: "共享回复", sticker: null };
    });
    const dispatcher = new ChannelDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      loadBoundConversationHistory,
      resolveBoundConversationId: vi.fn((sessionId: string) => sessionId === channelSessionId ? "conversation-7" : null),
      appendBoundConversationMessage,
      buildAndRunAgent,
    });

    const result = await dispatcher.handleIncoming(makeIncoming({ channel }));

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).not.toHaveBeenCalled();
    expect(loadBoundConversationHistory).toHaveBeenCalledWith("conversation-7", 16);
    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(1, "conversation-7", "user", "你好", {
      channel,
      senderName: "测试用户",
      modelContext: undefined,
    });
    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(2, "conversation-7", "assistant", "共享回复", {
      channel,
      senderName: "测试用户",
      modelContext: undefined,
    });
    expect(buildAndRunAgent).toHaveBeenCalledOnce();
  });

  it("keeps QQ group identity in model context without putting it in the visible bound message", async () => {
    const appendBoundConversationMessage = vi.fn();
    const dispatcher = new ChannelDispatcher({
      manager: makeManager(),
      resolveBoundConversationId: () => "conversation-group",
      loadBoundConversationHistory: vi.fn(async () => []),
      appendBoundConversationMessage,
      buildAndRunAgent: vi.fn(async () => ({ text: "收到", sticker: null })),
    });

    await dispatcher.handleIncoming(makeIncoming({
      channel: "qq",
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "大家好",
    }));

    expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(1, "conversation-group", "user", "大家好", {
      channel: "qq",
      senderName: "小明",
      modelContext: "[群聊发送者：小明 (10001)]\n大家好",
    });
  });

  it("falls back to channel history when bound desktop history cannot be loaded", async () => {
    const channelSessionId = makeSessionId("qq", "chat-1");
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道回退" }]);
    const loadBoundConversationHistory = vi.fn(async () => { throw new Error("桌面对话已删除"); });
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(channelSessionId);
      expect(prior).toEqual([{ role: "user", content: "渠道回退" }]);
      return { text: "回复", sticker: null };
    });
    const dispatcher = new ChannelDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      loadBoundConversationHistory,
      resolveBoundConversationId: () => "conversation-7",
      buildAndRunAgent,
    });

    await dispatcher.handleIncoming(makeIncoming());

    expect(loadRecentChannelHistory).toHaveBeenCalledWith(channelSessionId, 16);
    expect(buildAndRunAgent).toHaveBeenCalledWith(expect.anything(), channelSessionId, [{ role: "user", content: "渠道回退" }]);
  });

  it("falls back to the unbound channel path when binding lookup fails", async () => {
    const loadRecentChannelHistory = vi.fn(async () => [{ role: "user" as const, content: "渠道历史" }]);
    const buildAndRunAgent = vi.fn(async (_msg: IncomingMessage, sessionId: string, prior?: Array<{ role: string; content?: string }>) => {
      expect(sessionId).toBe(makeSessionId("qq", "chat-1"));
      expect(prior).toEqual([{ role: "user", content: "渠道历史" }]);
      return { text: "回复", sticker: null };
    });
    const dispatcher = new ChannelDispatcher({
      manager: makeManager(),
      loadRecentChannelHistory,
      resolveBoundConversationId: () => { throw new Error("绑定存储暂不可用"); },
      buildAndRunAgent,
    });

    const result = await dispatcher.handleIncoming(makeIncoming());

    expect(result?.targetId).toBe("chat-1");
    expect(loadRecentChannelHistory).toHaveBeenCalledWith(makeSessionId("qq", "chat-1"), 16);
  });
});
