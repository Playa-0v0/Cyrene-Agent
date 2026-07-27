// 任務清單 store —— todo_write 工具背後的持久化層。
//
// 設計：
// - 內存裡持有當前 TodoState，每次 setTodos 持久化到 userData/current-todos.json
// - 監聽者模式：主進程其他模塊（index.ts）訂閱變化，轉發 CUSTOM 事件給渲染端
// - 啟動時 loadTodos() 從磁盤恢復上次未完成的任務（跨重啟延續）
//
// 不做的事：
// - 不做多清單/多會話隔離（當前產品形態只有一個活躍清單夠用）
// - 不做歷史版本（覆蓋寫，簡單穩定）

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

/** 啟動時調一次，從磁盤恢復未完成的任務。 */
export function loadTodos(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(todoFilePath(), "utf8");
    const parsed = JSON.parse(raw) as TodoState;
    if (parsed && Array.isArray(parsed.todos)) {
      current = parsed;
      console.log("[TodoStore] 恢復 " + current.todos.length + " 條未完成任務");
    }
  } catch {
    current = { ...EMPTY_STATE };
  }
}

/** 整體覆蓋寫（todo_write 工具調這個）。返回更新後的 state。 */
export function setTodos(todos: TodoItem[]): TodoState {
  // 輕量校驗：丟掉字段不全的項
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

/** 訂閱變化。返回取消訂閱函數。 */
export function onTodosChange(cb: (s: TodoState) => void): () => void {
  listeners.push(cb);
  return () => { listeners = listeners.filter(l => l !== cb); };
}
