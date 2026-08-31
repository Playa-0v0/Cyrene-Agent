import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskDelegationRow } from "./TaskDelegationRow";

describe("TaskDelegationRow", () => {
  it("renders the playful running identity without a card container", () => {
    const html = renderToStaticMarkup(createElement(TaskDelegationRow, { delegation: {
      invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路",
      nickname: "风堇", assetFileName: "风堇.png", status: "running", roundId: "round-1",
    } }));

    expect(html).toContain("昔涟委托了");
    expect(html).toContain("风堇");
    expect(html).toContain("正在运行");
    expect(html).toContain("alt=\"风堇\"");
    expect(html).toContain("is-running");
  });

  it("renders a completed marker and completed copy", () => {
    const html = renderToStaticMarkup(createElement(TaskDelegationRow, { delegation: {
      invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路",
      nickname: "风堇", assetFileName: "风堇.png", status: "completed", roundId: "round-1",
    } }));
    expect(html).toContain("已完成");
    expect(html).toContain("✓");
  });
});
