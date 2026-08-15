// dispatcher 核心单元测试：sessionId hash + 限速
import { describe, it, expect } from "vitest";
import { makeSessionId, lookupOriginalSender } from "./dispatcher";

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

  it("makeSessionId: discord work/chat 歷史分開", () => {
    const w = makeSessionId("discord", "user-1", "work");
    const w2 = makeSessionId("discord", "user-1", "work");
    const c = makeSessionId("discord", "user-1", "chat");
    expect(w).toBe(w2);
    expect(w).not.toBe(c);
    expect(c).toMatch(/^channel:discord:chat:[0-9a-f]{16}$/);
    expect(w).toMatch(/^channel:discord:work:[0-9a-f]{16}$/);
  });

  it("lookupOriginalSender: 未知 sessionId 返回 null", () => {
    expect(lookupOriginalSender("channel:feishu:0000000000000000")).toBeNull();
  });
});