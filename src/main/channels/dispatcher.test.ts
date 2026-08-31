// dispatcher 核心单元测试：sessionId hash + 限速
import * as os from "node:os";
import { describe, it, expect, vi } from "vitest";
import { formatChannelUserText, makeSessionId, lookupOriginalSender } from "./dispatcher";

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
});
