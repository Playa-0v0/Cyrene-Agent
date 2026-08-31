import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../../../../../shared/chat-types";
import {
  applyAgentRoundBoundary,
  countRoundChangedFiles,
  createRoundProcessMessage,
  describeToolExecution,
  finishAgentRound,
  resolveAgentRoundTitle,
  startAgentRound,
} from "./agent-rounds";

function tool(
  id: string,
  name: string,
  status: ToolExecutionRecord["status"] = "success",
): ToolExecutionRecord {
  return { id, name, status, roundId: "round-0" };
}

describe("agent round presentation", () => {
  it("keeps terminal error text attached to the interrupted active round", () => {
    expect(createRoundProcessMessage("error-1", "模型请求失败", 3, "round-2")).toEqual({
      id: "error-1",
      content: "模型请求失败",
      afterToolCount: 3,
      roundId: "round-2",
    });
  });

  it("tracks the active round from ordered start and end events", () => {
    const started = applyAgentRoundBoundary({ rounds: [], activeRoundId: undefined }, "start", "round-0", 100);
    expect(started).toEqual({
      rounds: [{ id: "round-0", status: "running", startedAt: 100 }],
      activeRoundId: "round-0",
    });

    expect(applyAgentRoundBoundary(started, "end", "round-0", 250)).toEqual({
      rounds: [{ id: "round-0", status: "completed", startedAt: 100, completedAt: 250 }],
      activeRoundId: undefined,
    });
  });

  it("starts and finishes a stable model round", () => {
    const started = startAgentRound([], "round-0", 100);
    expect(started).toEqual([{ id: "round-0", status: "running", startedAt: 100 }]);

    expect(finishAgentRound(started, "round-0", 250)).toEqual([
      { id: "round-0", status: "completed", startedAt: 100, completedAt: 250 },
    ]);
  });

  it("uses the currently running tool as the live title", () => {
    const round = startAgentRound([], "round-0", 100)[0];
    expect(resolveAgentRoundTitle(round, [
      tool("a", "list_dir", "success"),
      tool("b", "read_file", "running"),
    ])).toBe("昔涟正在读取文件");
  });

  it("describes a running shell call with its exact command", () => {
    expect(describeToolExecution({
      id: "shell-1",
      name: "run_shell",
      status: "running",
      argsText: JSON.stringify({ command: "npm run test -- agent-rounds" }),
    })).toEqual({
      label: "运行命令",
      statusText: "正在运行命令",
      detail: "npm run test -- agent-rounds",
    });
  });

  it("describes a file write by its target path without exposing file contents", () => {
    expect(describeToolExecution({
      id: "write-1",
      name: "write_file",
      status: "running",
      argsText: JSON.stringify({ path: "src/renderer/App.tsx", content: "secret source" }),
    })).toEqual({
      label: "写入文件",
      statusText: "正在写入文件",
      detail: "src/renderer/App.tsx",
    });
  });

  it("keeps the activity useful when streamed arguments are malformed", () => {
    expect(describeToolExecution({
      id: "shell-2",
      name: "run_shell",
      status: "running",
      argsText: "{\"command\":",
    })).toEqual({
      label: "运行命令",
      statusText: "正在运行命令",
      detail: undefined,
    });
  });

  it("distinguishes a timed-out shell command from a generic execution failure", () => {
    expect(describeToolExecution({
      id: "shell-timeout",
      name: "run_shell",
      status: "error",
      argsText: JSON.stringify({ command: "npx serve . -l 3456" }),
      result: JSON.stringify({ timedOut: true, exitCode: null }),
    })).toEqual({
      label: "运行命令",
      statusText: "命令运行超时",
      detail: "npx serve . -l 3456",
    });
  });

  it("summarizes only truthful successful tool facts and reports failures", () => {
    const round = finishAgentRound(startAgentRound([], "round-0", 100), "round-0", 250)[0];
    expect(resolveAgentRoundTitle(round, [
      ...Array.from({ length: 5 }, (_, index) => tool(`dir-${index}`, "list_dir")),
      tool("read-1", "read_file"),
      tool("read-2", "read_file"),
      tool("read-failed", "read_file", "error"),
    ])).toBe("昔涟已完成 · 浏览 5 个目录 · 读取 2 个文件 · 1 项失败");
  });

  it("falls back to an operation count for tools without a semantic summary", () => {
    const round = finishAgentRound(startAgentRound([], "round-0", 100), "round-0", 250)[0];
    expect(resolveAgentRoundTitle(round, [
      tool("a", "custom_a"),
      tool("b", "custom_b"),
    ])).toBe("昔涟已完成 · 完成 2 项操作");
  });

  it("keeps an interrupted round honest instead of claiming completion", () => {
    const round = startAgentRound([], "round-0", 100)[0];
    expect(resolveAgentRoundTitle(round, [tool("a", "read_file", "error")], true))
      .toBe("昔涟已中断 · 1 项失败");
  });
});

describe("countRoundChangedFiles", () => {
  it("counts changed files deduplicated by path across tools", () => {
    const tools: ToolExecutionRecord[] = [
      {
        id: "a", name: "str_replace", status: "success", roundId: "round-0",
        changes: [{ file: "src/a.ts", kind: "modified", insertions: 1, deletions: 1 }],
      },
      {
        id: "b", name: "write_file", status: "success", roundId: "round-0",
        changes: [
          { file: "src/a.ts", kind: "modified", insertions: 2, deletions: 0 },
          { file: "src/b.ts", kind: "added", insertions: 5, deletions: 0 },
        ],
      },
      { id: "c", name: "read_file", status: "success", roundId: "round-0" },
    ];
    expect(countRoundChangedFiles(tools)).toBe(2);
  });

  it("returns 0 when no tool reports changes", () => {
    expect(countRoundChangedFiles([tool("a", "list_dir")])).toBe(0);
    expect(countRoundChangedFiles([])).toBe(0);
  });
});
