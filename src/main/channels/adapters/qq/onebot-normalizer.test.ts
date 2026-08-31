import { describe, expect, it, vi } from "vitest";
import type { OneBotActionClient } from "./onebot-action-client";
import type { OneBotMediaManager } from "./onebot-media";
import { messageMentionsSelf, normalizeOneBotMessage } from "./onebot-normalizer";
import type { OneBotMessageEvent } from "./onebot-types";

describe("normalizeOneBotMessage", () => {
  it("preserves segment order, removes the first bot mention, and expands one reply", async () => {
    const event: OneBotMessageEvent = {
      time: 1_700_000_000,
      self_id: "9000",
      post_type: "message",
      message_type: "group",
      message_id: "m-1",
      user_id: "1000",
      group_id: "2000",
      sender: { user_id: "1000", nickname: "小明", card: "群名片" },
      message: [
        { type: "at", data: { qq: "9000" } },
        { type: "text", data: { text: "先看" } },
        { type: "at", data: { qq: "3000" } },
        { type: "text", data: { text: "的图" } },
        { type: "reply", data: { id: "old-1" } },
        { type: "image", data: { file: "img-1" } },
      ],
    };
    const client = {
      call: vi.fn(async (action: string) => action === "get_msg"
        ? { sender: { user_id: "4000", nickname: "引用者" }, message: [{ type: "text", data: { text: "旧消息" } }] }
        : { card: "被提及者" }),
    } as unknown as OneBotActionClient;
    const media = {
      downloadSegment: vi.fn(async () => ({ kind: "image", filePath: "C:/cache/a.png", mime: "image/png" })),
    } as unknown as OneBotMediaManager;

    const result = await normalizeOneBotMessage(event, { selfId: "9000", client, media, supportsStream: true });
    expect(messageMentionsSelf(event, "9000")).toBe(true);
    expect(result).toMatchObject({
      channel: "qq",
      chatType: "group",
      chatId: "2000",
      senderId: "1000",
      senderName: "群名片",
      messageId: "m-1",
      reply: { messageId: "old-1", senderId: "4000", senderName: "引用者", text: "旧消息" },
    });
    expect(result.text).toBe("先看 @被提及者 的图[image]");
    expect(result.attachments).toHaveLength(1);
  });

  it("keeps a visible placeholder for unsupported segments instead of dropping them", async () => {
    const event: OneBotMessageEvent = {
      time: 1_700_000_000,
      self_id: "9000",
      post_type: "message",
      message_type: "private",
      message_id: "m-2",
      user_id: "1000",
      message: [
        { type: "text", data: { text: "看看这个" } },
        { type: "location", data: { lat: "31.2", lng: "121.4" } },
        { type: "forward", data: { id: "fwd-1" } },
      ],
    };
    const client = { call: vi.fn() } as unknown as OneBotActionClient;
    const media = {
      downloadSegment: vi.fn(),
    } as unknown as OneBotMediaManager;

    const result = await normalizeOneBotMessage(event, { selfId: "9000", client, media, supportsStream: true });
    // 位置/合并转发等未适配段必须显式占位，不能静默消失
    expect(result.text).toBe("看看这个[未支持的消息类型:location][未支持的消息类型:forward]");
  });
});
