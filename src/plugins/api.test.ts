import { describe, expect, it } from "vitest";
import type {
  PluginConversationMessage,
  PluginConversationSummary,
  PluginHostError,
  PluginMessagePage,
  PluginMessagePageInput,
  PluginTurnFinishedEvent,
  PluginTurnStartedEvent,
} from "./api";
import { isPluginHostError } from "./api";

describe("isPluginHostError", () => {
  it("识别带合法错误码的 Error", () => {
    const error: PluginHostError = Object.assign(
      new Error("会话不存在"),
      { code: "E_NOT_FOUND" as const },
    );
    expect(isPluginHostError(error)).toBe(true);
  });

  it("拒绝普通 Error、非 Error 值和未知错误码", () => {
    expect(isPluginHostError(new Error("普通错误"))).toBe(false);
    expect(isPluginHostError("E_NOT_FOUND")).toBe(false);
    expect(isPluginHostError(undefined)).toBe(false);
    expect(
      isPluginHostError(Object.assign(new Error("伪造"), { code: "E_FAKE" })),
    ).toBe(false);
  });
});

/**
 * 轮次事件按 source 收窄的编译期验证：分支内访问的必填字段
 * 必须是各来源独有的形状，字段写错或缺失时这里直接编译失败。
 */
function assertTurnEventNarrowing(
  started: PluginTurnStartedEvent,
  finished: PluginTurnFinishedEvent,
): string[] {
  const summary: string[] = [];
  if (started.source === "desktop") {
    summary.push(`desktop:${started.conversationId}:${started.inputMessageId}`);
  } else if (started.source === "channel") {
    summary.push(`channel:${started.channel}:${started.conversationId ?? "none"}`);
  } else {
    summary.push(`scheduler:${started.taskId}:${started.schedulerRunId}`);
  }
  if (finished.source === "desktop") {
    // finalMessageId 只在宿主确认落盘后存在，分支内按可选字段访问。
    summary.push(`desktop:${finished.status}:${finished.finalMessageId ?? "unset"}`);
  } else if (finished.source === "channel") {
    summary.push(`channel:${finished.status}:${finished.channel}`);
  } else {
    summary.push(`scheduler:${finished.status}:${finished.taskId}`);
  }
  return summary;
}

describe("轮次事件联合类型", () => {
  it("按 source 收窄各来源的必填字段", () => {
    const base = { eventId: "evt-1", timestamp: "2026-09-03T00:00:00Z", runId: "run-1", mode: "chat" as const };
    const summary = assertTurnEventNarrowing(
      { ...base, source: "desktop", conversationId: "c1", inputMessageId: "m1" },
      { ...base, source: "scheduler", taskId: "t1", schedulerRunId: "sr1", status: "success" },
    );
    expect(summary).toEqual([
      "desktop:c1:m1",
      "scheduler:success:t1",
    ]);
  });
});

/**
 * 长期记忆插件的标准调用路径编译期验证：桌面轮次结束事件的消息边界
 * 必须能无损传给 getMessages()。字段改名或类型漂移时这里直接编译失败。
 */
function assertTurnBoundariesFeedGetMessages(
  event: PluginTurnFinishedEvent,
  getMessages: (input: PluginMessagePageInput) => Promise<PluginMessagePage>,
): Promise<PluginMessagePage> | undefined {
  if (event.source !== "desktop" || !event.finalMessageId) return undefined;
  return getMessages({
    conversationId: event.conversationId,
    fromMessageId: event.inputMessageId,
    throughMessageId: event.finalMessageId,
  });
}

describe("会话只读服务类型", () => {
  it("桌面轮次事件边界可直接作为 getMessages 的冻结边界", async () => {
    const pages: PluginMessagePage[] = [
      {
        items: [{ id: "m1", role: "user", text: "你好", at: "2026-09-03T00:00:01Z" }] satisfies PluginConversationMessage[],
        range: { fromMessageId: "m1", throughMessageId: "m2" },
      },
    ];
    const result = await assertTurnBoundariesFeedGetMessages(
      {
        eventId: "evt-2",
        timestamp: "2026-09-03T00:00:02Z",
        runId: "run-2",
        mode: "chat",
        source: "desktop",
        conversationId: "c1",
        inputMessageId: "m1",
        finalMessageId: "m2",
        status: "success",
      },
      async () => pages[0],
    );
    expect(result?.range).toEqual({ fromMessageId: "m1", throughMessageId: "m2" });
  });

  it("会话列表投影包含稳定字段集合", () => {
    const summary: PluginConversationSummary = {
      id: "c1",
      title: "示例会话",
      mode: "chat",
      createdAt: "2026-09-03T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
    };
    expect(Object.keys(summary).sort()).toEqual([
      "createdAt",
      "id",
      "mode",
      "title",
      "updatedAt",
    ]);
  });
});
