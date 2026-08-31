import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", async () => {
  const ReactModule = await import("react");
  return {
    Bubble: { List: () => null },
    CodeHighlighter: () => null,
    Think: ({ icon, title, children }: { icon?: React.ReactNode; title?: React.ReactNode; children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, icon, title, children),
    ThoughtChain: () => null,
  };
});
vi.mock("@ant-design/x-markdown", () => ({ XMarkdown: ({ content }: { content?: string }) => content ?? null }));
vi.mock("@ant-design/x-markdown/plugins/Latex", () => ({ default: () => ({}) }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { createMessageItems, RunActivityDetail, type ChatMessageItem } from "./ChatMessageList";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";

describe("React chat sticker messages", () => {
  it("extracts a persisted user sticker marker and hides the raw marker", () => {
    expect(extractMessageStickerId("[sticker:hugtight]")).toBe("hugtight");
    expect(stripMessageStickerMarkers("[sticker:hugtight]")).toBe("");
  });

  it("keeps user text while removing only its sticker marker", () => {
    expect(stripMessageStickerMarkers("给你一个 [sticker:hugtight]")).toBe("给你一个");
  });
});

describe("formal answer visibility", () => {
  it("keeps an interrupted run in the process area without creating an empty assistant bubble", () => {
    const message: ChatMessageItem = {
      id: "assistant-interrupted",
      role: "assistant",
      content: "",
      responseStarted: false,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0, keepExpanded: true },
      processMessages: [{ id: "process-1", content: "已经检查了文件", afterToolCount: 0 }],
    };

    expect(createMessageItems([message], []).map((item) => item.role)).toEqual(["activity"]);
  });
});

describe("review panel visibility", () => {
  it("appends a review bubble when runId is set and message is not streaming", () => {
    const message: ChatMessageItem = {
      id: "assistant-done",
      role: "assistant",
      content: "完成了",
      streaming: false,
      runId: "run-abc-123",
    };
    const roles = createMessageItems([message], []).map((item) => item.role);
    expect(roles).toContain("review");
    const reviewItem = createMessageItems([message], []).find((item) => item.role === "review");
    expect(reviewItem?.extraInfo?.runId).toBe("run-abc-123");
  });

  it("does not append review bubble while streaming", () => {
    const message: ChatMessageItem = {
      id: "assistant-streaming",
      role: "assistant",
      content: "正在处理",
      streaming: true,
      runId: "run-abc-456",
    };
    const roles = createMessageItems([message], []).map((item) => item.role);
    expect(roles).not.toContain("review");
  });

  it("does not append review bubble when runId is absent", () => {
    const message: ChatMessageItem = {
      id: "assistant-no-run",
      role: "assistant",
      content: "纯对话",
      streaming: false,
    };
    const roles = createMessageItems([message], []).map((item) => item.role);
    expect(roles).not.toContain("review");
  });
});

describe("function-calling round presentation", () => {
  it("renders one collapsible activity group per model round with reasoning inside", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [
        { id: "round-0", status: "completed", startedAt: 1, completedAt: 2 },
        { id: "round-1", status: "running", startedAt: 3 },
      ],
      processMessages: [
        { id: "process-0", roundId: "round-0", content: "先看项目结构" },
        { id: "process-1", roundId: "round-1", content: "继续检查取消链路" },
      ],
      reasoningBlocks: [
        { id: "reason-0", roundId: "round-1", content: "已经理清目录结构", streaming: false },
        { id: "reason-1", roundId: "round-1", content: "查找 IPC 入口", streaming: true },
      ],
      tools: [
        { id: "tool-0", roundId: "round-0", name: "list_dir", status: "success" },
        { id: "tool-1", roundId: "round-1", name: "read_file", status: "running" },
      ],
      interrupted: false,
    }));

    expect(html.match(/class="cy-agent-round(?: is-(?:running|complete))?"/g)).toHaveLength(2);
    expect(html.match(/class="cy-agent-round__art"/g)).toHaveLength(2);
    expect(html.match(/class="cy-agent-round__art-image"/g)).toHaveLength(2);
    expect(html).not.toContain("cy-agent-round__status");
    expect(html).toContain("cy-reasoning-status-art is-thinking");
    const thinkingArt = html.match(/cy-reasoning-status-art is-thinking[^>]*><img src="([^"]+)"/)?.[1];
    const completedArt = html.match(/cy-reasoning-status-art is-complete[^>]*><img src="([^"]+)"/)?.[1];
    expect(completedArt).toBe(thinkingArt);
    expect(html).toContain("昔涟已完成 · 浏览 1 个目录");
    expect(html).toContain("昔涟正在读取文件");
    expect(html).toContain("先看项目结构");
    expect(html).toContain("继续检查取消链路");
    expect(html).toContain("查找 IPC 入口");
  });

  it("appends a pink changed-files hint after the completed round title", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-0", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [],
      reasoningBlocks: [],
      tools: [{
        id: "tool-0", roundId: "round-0", name: "str_replace", status: "success",
        changes: [{ file: "src/a.ts", kind: "modified", insertions: 3, deletions: 1 }],
      }],
      interrupted: false,
    }));

    expect(html).toContain("昔涟已完成");
    expect(html).toContain('class="cy-agent-round__files"');
    expect(html).toContain("1 个文件已被改动");
  });

  it("does not render an empty final-answer round as a fake completed operation", async () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-final", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [],
      reasoningBlocks: [],
      tools: [],
      interrupted: false,
    }));
    expect(html).not.toContain("cy-agent-round");
  });

  it("keeps function-calling narration visible after its round collapses", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-complete", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [{ id: "process-complete", roundId: "round-complete", content: "人家先去看一眼目录结构" }],
      reasoningBlocks: [],
      tools: [{ id: "tool-complete", roundId: "round-complete", name: "list_dir", status: "success" }],
      interrupted: false,
    }));

    expect(html).toContain("人家先去看一眼目录结构");
  });

  it("renders a task delegation in its owning tool round", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-task", status: "running", startedAt: 1 }],
      processMessages: [],
      reasoningBlocks: [],
      taskDelegations: [{
        invocationId: "child-run-1",
        taskId: "task-1",
        description: "检查取消链路",
        nickname: "风堇",
        assetFileName: "风堇.png",
        status: "running",
        roundId: "round-task",
      }],
      tools: [],
      interrupted: false,
    }));

    expect(html).toContain("昔涟委托了");
    expect(html).toContain("风堇");
    expect(html).toContain("检查取消链路");
  });
});
