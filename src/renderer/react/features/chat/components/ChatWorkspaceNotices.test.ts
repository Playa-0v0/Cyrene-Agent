import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunRecoveryNotices } from "./ChatWorkspaceNotices";

describe("RunRecoveryNotices", () => {
  it("offers to resume an interrupted run while the session is idle", () => {
    const html = renderToStaticMarkup(createElement(RunRecoveryNotices, {
      interruptedRun: { runId: "run-1", rounds: 3, todoCount: 2 },
      sessionTakeover: null,
      activeSessionId: "session-1",
      isRunning: false,
      onResume: () => undefined,
      onTakeover: () => undefined,
    }));

    expect(html).toContain("已进行 3 轮");
    expect(html).toContain("继续任务");
  });

  it("does not render the takeover notice on the welcome screen (no active session)", () => {
    const html = renderToStaticMarkup(createElement(RunRecoveryNotices, {
      interruptedRun: null,
      sessionTakeover: null,
      activeSessionId: undefined,
      isRunning: false,
      onResume: () => undefined,
      onTakeover: () => undefined,
    }));

    expect(html).not.toContain("正在运行的任务");
  });
});
