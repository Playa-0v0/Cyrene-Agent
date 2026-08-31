import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { createSchedulerStore } from "./scheduler-store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-scheduler-"));
}

describe("scheduler store", () => {
  it("adds and persists a normalized task", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });

    store.load();
    const task = store.addTask({
      title: "  Morning  ",
      prompt: "  Summarize my day  ",
      schedule: { kind: "daily", timeOfDay: "09:00" },
      toolMode: "allow-list",
      allowedToolIds: ["weather", "weather", "calendar"],
    });

    expect(task.title).toBe("Morning");
    expect(task.prompt).toBe("Summarize my day");
    expect(task.allowedToolIds).toEqual(["weather", "calendar"]);
    expect(task.nextFireAt).toBeTruthy();

    const store2 = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-2",
    });
    store2.load();
    expect(store2.getTasks()).toHaveLength(1);
    expect(store2.getTasks()[0].title).toBe("Morning");
  });

  it("keeps 50 history entries per task and 1000 globally", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    store.load();

    for (let i = 0; i < 60; i += 1) {
      store.recordHistory({
        id: `a-${i}`,
        taskId: "task-a",
        taskTitle: "A",
        firedAt: new Date(2026, 5, 22, 8, i).toISOString(),
        status: "success",
        effectiveToolIds: [],
      });
    }

    expect(store.getHistory("task-a", 100)).toHaveLength(50);
    expect(store.getHistory("task-a", 1)[0].id).toBe("a-59");
  });

  it("generates a unique task id when the id provider collides", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "same-id",
    });
    store.load();

    const first = store.addTask({ title: "A", prompt: "Run A", schedule: { kind: "daily", timeOfDay: "08:00" } });
    const second = store.addTask({ title: "B", prompt: "Run B", schedule: { kind: "daily", timeOfDay: "09:00" } });

    expect(first.id).toBe("same-id");
    expect(second.id).not.toBe("same-id");
    expect(new Set(store.getTasks().map(task => task.id)).size).toBe(2);
  });

  it("replaces a running history entry when the final entry has the same id", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });
    store.load();

    store.recordHistory({ id: "hist-1", taskId: "task-a", taskTitle: "A", firedAt: "2026-06-22T08:00:00.000Z", status: "running", effectiveToolIds: [] });
    store.recordHistory({ id: "hist-1", taskId: "task-a", taskTitle: "A", firedAt: "2026-06-22T08:00:00.000Z", finishedAt: "2026-06-22T08:00:05.000Z", status: "success", outputPreview: "done", effectiveToolIds: [] });

    const history = store.getHistory("task-a", 10);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("success");
  });

  it("normalizes persisted tasks instead of crashing on old missing optional arrays", () => {
    const dir = tmpDir();
    const tasksFile = path.join(dir, "scheduled-tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        id: "task-a",
        title: "A",
        prompt: "Run A",
        enabled: true,
        schedule: { kind: "daily", timeOfDay: "08:00" },
        nextFireAt: "2026-06-22T08:00:00.000Z",
        toolMode: "allow-list",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      }],
    }), "utf8");
    const store = createSchedulerStore({
      tasksFile,
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });

    store.load();

    expect(store.getTasks()[0].allowedToolIds).toEqual([]);
  });

  it("rolls a stale recurring nextFireAt forward when re-enabled", () => {
    const dir = tmpDir();
    let now = new Date("2026-06-22T08:00:00.000Z");
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => now,
      id: () => "task-a",
    });
    store.load();

    const task = store.addTask({
      title: "Hourly",
      prompt: "Run hourly",
      schedule: { kind: "interval", every: 1, unit: "hours" },
    });
    expect(task.nextFireAt).toBe("2026-06-22T09:00:00.000Z");

    store.toggleTask(task.id, false);
    now = new Date("2026-06-22T12:15:00.000Z");
    const enabled = store.toggleTask(task.id, true);

    expect(enabled.nextFireAt).toBe("2026-06-22T13:00:00.000Z");
  });
});
