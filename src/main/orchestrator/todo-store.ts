// 任务清单 store —— todo_write 工具背后的持久化层。
//
// 设计：
// - 内存里持有当前 TodoState，每次 setTodos 持久化到 userData/current-todos.json
// - 监听者模式：主进程其他模块（index.ts）订阅变化，转发 CUSTOM 事件给渲染端
// - 启动时 loadTodos() 从磁盘恢复上次未完成的任务（跨重启延续）
//
// 不做的事：
// - 不做多清单/多会话隔离（当前产品形态只有一个活跃清单够用）
// - 不做历史版本（覆盖写，简单稳定）

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
}

export interface TodoState {
  todos: TodoItem[];
  updatedAt: number;
}

const EMPTY_STATE: TodoState = { todos: [], updatedAt: 0 };

let current: TodoState = { ...EMPTY_STATE };
let listeners: Array<(s: TodoState) => void> = [];
let loaded = false;

function todoFilePath(): string {
  return path.join(app.getPath("userData"), "current-todos.json");
}

function persist(): void {
  try {
    fs.writeFileSync(todoFilePath(), JSON.stringify(current, null, 2), "utf8");
  } catch (e) {
    console.warn("[TodoStore] persist failed:", e);
  }
}

/** 启动时调一次，从磁盘恢复未完成的任务。 */
export function loadTodos(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(todoFilePath(), "utf8");
    const parsed = JSON.parse(raw) as TodoState;
    if (parsed && Array.isArray(parsed.todos)) {
      current = parsed;
      console.log("[TodoStore] 恢复 " + current.todos.length + " 条未完成任务");
    }
  } catch {
    current = { ...EMPTY_STATE };
  }
}

/** 整体覆盖写（todo_write 工具调这个）。返回更新后的 state。 */
export function setTodos(todos: TodoItem[]): TodoState {
  // 轻量校验：丢掉字段不全的项
  const valid = todos.filter(t => t && typeof t.id === "string" && typeof t.content === "string");
  current = { todos: valid, updatedAt: Date.now() };
  persist();
  for (const l of listeners) {
    try { l(current); } catch (e) { console.warn("[TodoStore] listener error:", e); }
  }
  return current;
}

export function getTodos(): TodoState {
  return current;
}

export function clearTodos(): void {
  current = { todos: [], updatedAt: Date.now() };
  persist();
  for (const l of listeners) {
    try { l(current); } catch (e) { console.warn("[TodoStore] listener error:", e); }
  }
}

/** 订阅变化。返回取消订阅函数。 */
export function onTodosChange(cb: (s: TodoState) => void): () => void {
  listeners.push(cb);
  return () => { listeners = listeners.filter(l => l !== cb); };
}
