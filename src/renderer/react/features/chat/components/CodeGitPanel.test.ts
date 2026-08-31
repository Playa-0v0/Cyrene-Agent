import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../assets/status-moods/工作中.png?url", () => ({ default: "working.png" }));
vi.mock("./ChatMessageList", () => ({ MarkdownContent: () => null }));

import { CodeGitPanel } from "./CodeGitPanel";

describe("CodeGitPanel", () => {
  it("uses an application modal instead of Electron's unsupported prompt for Git operations", () => {
    const source = readFileSync(resolve(__dirname, "CodeGitPanel.tsx"), "utf8");

    expect(source).toContain('from "antd"');
    expect(source).toContain("<Modal");
    expect(source).not.toContain("window.prompt");
  });

  it("keeps Git actions fixed and places the plan review entry below the scrollable Todo list", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(CodeGitPanel, {
      sessionId: "s1",
      projectName: "cyrene-project",
      planPhase: "review",
      onOpenPlan: vi.fn(),
      todoState: { updatedAt: 1, todos: [{ id: "t1", content: "完成审阅 UI", status: "pending" }] },
    }));

    expect(html).toContain("Coding");
    expect(html).toContain("cyrene-project");
    expect(html).toContain("分支切换");
    expect(html).toContain("提交或推送");
    expect(html).toContain('data-testid="code-todo-list"');
    expect(html).toContain("完成审阅 UI");
    expect(html).toContain('data-testid="code-plan-status"');
    const todoListEnd = html.indexOf("</ul>", html.indexOf('data-testid="code-todo-list"'));
    const planStatusStart = html.indexOf('data-testid="code-plan-status"');
    expect(planStatusStart).toBeGreaterThan(todoListEnd);
    expect(html.slice(planStatusStart)).toContain("计划待审批 · 点击查看");
    expect(html.slice(planStatusStart)).toContain("cy-plan-entry");
    expect(html.slice(planStatusStart)).not.toContain("cy-plan-control");
    expect(html).not.toContain(">审阅<");
  });
});
