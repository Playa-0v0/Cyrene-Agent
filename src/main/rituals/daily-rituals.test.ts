import { describe, expect, it } from "vitest";
import { getDailyRitualPrompt, syncDailyRitualTasks, type DailyRitualSettings } from "./daily-rituals";
import type { NewScheduledTaskInput, ScheduledTask, ScheduledTaskPatch } from "../scheduler/types";

function settings(patch: Partial<DailyRitualSettings> = {}): DailyRitualSettings {
  return {
    dailyRitualEnabled: true,
    dailyRitualVoice: true,
    dailyRitualMorningEnabled: true,
    dailyRitualMorningTime: "08:00",
    dailyRitualAfternoonEnabled: true,
    dailyRitualAfternoonTime: "15:00",
    dailyRitualEveningEnabled: true,
    dailyRitualEveningTime: "22:30",
    ...patch,
  };
}

function fakeStore() {
  let tasks: ScheduledTask[] = [];
  let sequence = 0;
  const stamp = "2026-07-13T00:00:00.000Z";
  return {
    getTasks: () => tasks.map(task => ({ ...task })),
    addTask: (input: NewScheduledTaskInput) => {
      const task: ScheduledTask = {
        id: `task-${++sequence}`,
        title: input.title,
        prompt: input.prompt,
        enabled: input.enabled !== false,
        schedule: input.schedule,
        nextFireAt: stamp,
        toolMode: input.toolMode ?? "all-enabled",
        allowedToolIds: input.allowedToolIds ?? [],
        managedBy: input.managedBy,
        ritualId: input.ritualId,
        createdAt: stamp,
        updatedAt: stamp,
      };
      tasks.push(task);
      return { ...task };
    },
    updateTask: (id: string, patch: ScheduledTaskPatch) => {
      const index = tasks.findIndex(task => task.id === id);
      if (index < 0) throw new Error("missing task");
      tasks[index] = { ...tasks[index], ...patch, updatedAt: stamp } as ScheduledTask;
      return { ...tasks[index] };
    },
  };
}

describe("daily rituals", () => {
  it("建立三個每日任務，並在再次同步時保留 id", () => {
    const store = fakeStore();
    const first = syncDailyRitualTasks(settings(), store);
    const second = syncDailyRitualTasks(settings({ dailyRitualMorningTime: "09:15" }), store);

    expect(first).toHaveLength(3);
    expect(second.map(task => task.id)).toEqual(first.map(task => task.id));
    expect(second[0].schedule).toEqual({ kind: "daily", timeOfDay: "09:15" });
    expect(second[0].allowedToolIds).toEqual(["weather"]);
    expect(second[1].allowedToolIds).toEqual([]);
  });

  it("總開關關閉時停用全部任務，但保留各時段設定", () => {
    const store = fakeStore();
    const tasks = syncDailyRitualTasks(settings({ dailyRitualEnabled: false }), store);
    expect(tasks.every(task => task.enabled === false)).toBe(true);
  });

  it("把未完成待辦附加到儀式提示詞", () => {
    const task = syncDailyRitualTasks(settings(), fakeStore())[2];
    const prompt = getDailyRitualPrompt(task, "- [待辦] 整理報告");
    expect(prompt).toContain("目前待辦摘要");
    expect(prompt).toContain("整理報告");
  });
});
