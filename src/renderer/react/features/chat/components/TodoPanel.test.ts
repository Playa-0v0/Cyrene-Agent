import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodoPanel } from "./TodoPanel";

describe("TodoPanel layout structure", () => {
  it("keeps the progress and project-status extension outside the scrollable task list", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(TodoPanel, {
      mode: "work",
      workspaceName: "cyrene-project",
      state: {
        updatedAt: 1,
        todos: Array.from({ length: 20 }, (_, index) => ({
          id: `todo-${index}`,
          content: `任务 ${index}`,
          status: index === 0 ? "completed" as const : "pending" as const,
        })),
      },
    }));

    expect(html).toContain('data-testid="todo-list"');
    expect(html).toContain('data-testid="todo-footer"');
    const listEnd = html.indexOf("</ul>", html.indexOf('data-testid="todo-list"'));
    const footerStart = html.indexOf('data-testid="todo-footer"');
    expect(footerStart).toBeGreaterThan(listEnd);
    expect(html.slice(footerStart)).toContain('data-testid="todo-extension-slot"');
    expect(html.slice(footerStart)).toContain("项目状态");
    expect(html.slice(footerStart)).not.toContain("当前工作路径");
    expect(html.slice(footerStart)).toContain('role="progressbar"');
  });
});
