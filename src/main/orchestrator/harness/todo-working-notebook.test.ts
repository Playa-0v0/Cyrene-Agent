import { describe, expect, it } from "vitest";
import {
  buildCurrentTodoNotebookContext,
  TODO_WORKING_NOTEBOOK_POLICY,
} from "./todo-working-notebook";

describe("Todo mutable working notebook policy", () => {
  it("uses execution steps and tool rounds instead of LLM call count", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("至少 2 个 execution step");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("tool round");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("不按 LLM 调用次数");
  });

  it("keeps Todo mutable, optional for simple tasks, and non-binding", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("mutable working notebook");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("可变工作笔记");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("单次工具即可完成");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("不得作为后续行动的强约束");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("方向改变");
  });

  it("renders an empty mutable notebook without turning it into an obligation", () => {
    expect(buildCurrentTodoNotebookContext([])).toBe(
      `[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]\n（当前工作笔记为空）\n[/CURRENT_TODO_NOTEBOOK]`,
    );
  });

  it("renders the current Todo facts as a read-only notebook snapshot", () => {
    expect(buildCurrentTodoNotebookContext([
      { id: "inspect", content: "检查目录结构", status: "completed" },
      { id: "fix", content: "修正取消链路", status: "in_progress", activeForm: "正在修正取消链路" },
    ])).toBe(
      `[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]\n`
      + `[completed] inspect: 检查目录结构\n`
      + `[in_progress] fix: 修正取消链路（当前：正在修正取消链路）\n`
      + `[/CURRENT_TODO_NOTEBOOK]`,
    );
  });
});
