import type { TodoItem } from "./types";

export const TODO_WORKING_NOTEBOOK_POLICY = `[TODO_WORKING_NOTEBOOK_POLICY]
Todo 是你的 mutable working notebook（可变工作笔记），用于像人类手边的笔记本一样记录当前方向和阶段进度。
- 如果预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次），优先调用 update_todo 建立一份简短清单。
- “两轮”按执行步骤/工具推进轮次理解，不按 LLM 调用次数计算。
- 单次工具即可完成的简单任务（例如一次天气查询）不需要 Todo。
- 当 Todo 为空但任务已经显现为多步、Todo 与事实不符、一个阶段完成、用户改变目标或发生方向改变时，及时调用 update_todo 修订或重写它。
- Todo 不得作为后续行动的强约束；先依据用户当前目标和最新工具事实判断，再修订笔记并继续。
- Todo 不是外部操作已经成功的证明。`;

export function buildCurrentTodoNotebookContext(items: TodoItem[]): string {
  const header = `[CURRENT_TODO_NOTEBOOK mutable="true" binding="false"]`;
  if (items.length === 0) {
    return `${header}\n（当前工作笔记为空）\n[/CURRENT_TODO_NOTEBOOK]`;
  }

  const lines = items.map((item) => {
    const active = item.activeForm ? `（当前：${item.activeForm}）` : "";
    return `[${item.status}] ${item.id}: ${item.content}${active}`;
  });
  return `${header}\n${lines.join("\n")}\n[/CURRENT_TODO_NOTEBOOK]`;
}
