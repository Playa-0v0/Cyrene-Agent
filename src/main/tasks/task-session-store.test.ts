import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSessionStore } from "./task-session-store";

const temporaryRoots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-session-"));
  temporaryRoots.push(root);
  let now = 1_000;
  let nextId = 1;
  return {
    root,
    tick: () => { now += 1; },
    store: new TaskSessionStore(root, {
      now: () => now,
      createId: () => `task-${nextId++}`,
      createChildRunId: () => `child-run-${nextId}`,
    }),
  };
}

function createInput() {
  return {
    parentConversationId: "chat-1",
    parentRunId: "run-1",
    description: "检查取消链路",
    prompt: "检查取消传播并列出证据。",
    subagentType: "general" as const,
    mode: "code" as const,
    resolvedWorkspaceRoot: "E:\\project",
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TaskSessionStore", () => {
  it("persists a private running child session outside chat sessions", () => {
    const { root, store } = createStore();

    const created = store.create(createInput());

    expect(created).toMatchObject({
      id: "task-1",
      parentConversationId: "chat-1",
      parentRunId: "run-1",
      childRunId: "child-run-2",
      status: "running",
      messages: [{ role: "user", content: "检查取消传播并列出证据。" }],
      trace: [],
    });
    expect(fs.existsSync(path.join(root, "cyrene-tasks", "sessions", "task-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "cyrene-chats", "sessions", "task-1.json"))).toBe(false);
    expect(store.get("task-1")).toMatchObject({ id: "task-1" });
    expect(store.listForParent("chat-2")).toEqual([]);
  });

  it("resumes only a task owned by the same conversation and profile", () => {
    const { store, tick } = createStore();
    const created = store.create(createInput());
    store.checkpoint(created.id, { status: "completed", resultText: "首轮检查完成" });
    tick();

    const resumed = store.resume(created.id, {
      parentConversationId: "chat-1",
      parentRunId: "run-2",
      subagentType: "general",
      prompt: "继续检查权限等待时的取消。",
    });

    expect(resumed).toMatchObject({ status: "running", parentRunId: "run-2" });
    expect(resumed.messages).toEqual([
      { role: "user", content: "检查取消传播并列出证据。" },
      { role: "user", content: "继续检查权限等待时的取消。" },
    ]);
    expect(() => store.resume(created.id, {
      parentConversationId: "chat-2",
      parentRunId: "run-3",
      subagentType: "general",
      prompt: "不应访问。",
    })).toThrow("TASK_PARENT_MISMATCH");
    expect(() => store.resume(created.id, {
      parentConversationId: "chat-1",
      parentRunId: "run-3",
      subagentType: "search",
      prompt: "不应改变类型。",
    })).toThrow("TASK_PROFILE_MISMATCH");
  });

  it("marks a persisted running task as interrupted after restart", () => {
    const { root, store } = createStore();
    const created = store.create(createInput());

    const restarted = new TaskSessionStore(root);

    expect(restarted.get(created.id)).toMatchObject({
      id: created.id,
      status: "interrupted",
      messages: [{ role: "user", content: "检查取消传播并列出证据。" }],
    });
  });

  it("persists a task Todo notebook across restart without exposing mutable storage", () => {
    const { root, store } = createStore();
    const created = store.create(createInput());

    store.checkpoint(created.id, {
      todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
    });

    const restarted = new TaskSessionStore(root);
    const restored = restarted.get(created.id);

    expect(restored?.todoItems).toEqual([
      { id: "inspect", content: "检查取消链路", status: "in_progress" },
    ]);

    restored?.todoItems.push({ id: "report", content: "整理报告", status: "pending" });
    expect(restarted.get(created.id)?.todoItems).toEqual([
      { id: "inspect", content: "检查取消链路", status: "in_progress" },
    ]);

    const sibling = restarted.create({ ...createInput(), description: "另一个子任务" });
    expect(sibling.todoItems).toEqual([]);
  });
});
