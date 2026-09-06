import { describe, expect, it } from "vitest";
import { resolveRevisableLastTurn } from "./last-turn-actions";

const completedConversation = [
  { id: "u1", role: "user" as const, content: "hello" },
  { id: "a1", role: "assistant" as const, content: "hi", responseStarted: true },
  { id: "u2", role: "user" as const, content: "我喜欢吃苹果" },
  { id: "a2", role: "assistant" as const, content: "我也喜欢", responseStarted: true },
  { id: "u3", role: "user" as const, content: "那你还喜欢什么" },
  { id: "a3", role: "assistant" as const, content: "草莓", responseStarted: true },
];

describe("resolveRevisableLastTurn", () => {
  it("exposes only the final completed user/assistant pair in Chat mode", () => {
    expect(resolveRevisableLastTurn(completedConversation, "chat")).toEqual({
      userMessageId: "u3",
      assistantMessageId: "a3",
    });
  });

  it("accepts the persisted model role used by the chat store", () => {
    expect(resolveRevisableLastTurn([
      { id: "u3", role: "user", content: "问题" },
      { id: "a3", role: "model", content: "回答" },
    ], "chat")).toEqual({ userMessageId: "u3", assistantMessageId: "a3" });
  });

  it.each(["work", "code", "learn"] as const)("does not expose actions in %s mode", (mode) => {
    expect(resolveRevisableLastTurn(completedConversation, mode)).toBeNull();
  });

  it("waits until the final assistant response is completely generated", () => {
    expect(resolveRevisableLastTurn([
      { id: "u3", role: "user", content: "问题" },
      { id: "a3", role: "assistant", content: "生成中", responseStarted: true, streaming: true },
    ], "chat")).toBeNull();

    expect(resolveRevisableLastTurn([
      { id: "u3", role: "user", content: "问题" },
      { id: "a3", role: "assistant", content: "", loading: true },
    ], "chat")).toBeNull();
  });

  it("does not expose actions for an unmatched trailing user message", () => {
    expect(resolveRevisableLastTurn([
      ...completedConversation,
      { id: "u4", role: "user", content: "还没有回复" },
    ], "chat")).toBeNull();
  });

  it("does not expose actions when the final user message came from a bound channel", () => {
    expect(resolveRevisableLastTurn([
      { id: "u3", role: "user", content: "微信消息", channelSource: { channel: "wechat" as const } },
      { id: "a3", role: "assistant", content: "渠道回复" },
    ], "chat")).toBeNull();
  });

  it("does not expose actions when the final assistant message is mirrored to a bound channel", () => {
    expect(resolveRevisableLastTurn([
      { id: "u3", role: "user", content: "渠道消息" },
      { id: "a3", role: "assistant", content: "QQ 回复", channelSource: { channel: "qq" as const } },
    ], "chat")).toBeNull();
  });
});
