export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export interface TodoState {
  todos: TodoItem[];
  updatedAt: number;
  /** 该清单所属模式；用于多模式隔离（work / learn）。 */
  mode?: "work" | "learn";
}
