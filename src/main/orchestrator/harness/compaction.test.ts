import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../vendors/types";
import {
  compressForAgentLoop,
  findSafeCutPointForRetainedTokens,
} from "./compaction";

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("Harness context compaction v2", () => {
  it("keeps a tool call and its result in the retained token-budgeted tail", () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务"),
      {
        role: "assistant",
        content: "我先读取文件。",
        toolCalls: [{ id: "call-read", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call-read", name: "read_file", content: "文件内容".repeat(30) },
      message("user", "请根据结果继续".repeat(20)),
    ];

    const cutIndex = findSafeCutPointForRetainedTokens(messages, 100);

    expect(cutIndex).toBe(1);
    expect(messages.slice(cutIndex).map((entry) => entry.role)).toEqual([
      "assistant", "tool", "user",
    ]);
  });

  it("keeps the original transcript when summary generation fails", async () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务".repeat(30)),
      message("assistant", "旧结论".repeat(30)),
      message("user", "最新任务".repeat(30)),
    ];

    const result = await compressForAgentLoop({
      messages,
      retainTokens: 20,
      summarize: async () => { throw new Error("summary unavailable"); },
    });

    expect(result).toBe(messages);
  });

  it("keeps the original transcript when the summary is not smaller", async () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务".repeat(30)),
      message("assistant", "旧结论".repeat(30)),
      message("user", "最新任务".repeat(30)),
    ];

    const result = await compressForAgentLoop({
      messages,
      retainTokens: 20,
      summarize: async () => "摘要".repeat(200),
    });

    expect(result).toBe(messages);
  });
});
