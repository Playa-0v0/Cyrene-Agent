import type { NewScheduledTaskInput, ScheduledTask, ScheduledTaskPatch } from "../scheduler/types";

export type DailyRitualId = "morning" | "afternoon" | "evening";

export interface DailyRitualSettings {
  dailyRitualEnabled: boolean;
  dailyRitualVoice: boolean;
  dailyRitualMorningEnabled: boolean;
  dailyRitualMorningTime: string;
  dailyRitualAfternoonEnabled: boolean;
  dailyRitualAfternoonTime: string;
  dailyRitualEveningEnabled: boolean;
  dailyRitualEveningTime: string;
}

interface SchedulerStoreLike {
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): ScheduledTask;
  updateTask(id: string, patch: ScheduledTaskPatch): ScheduledTask;
}

const RITUALS: Array<{
  id: DailyRitualId;
  title: string;
  enabledKey: keyof DailyRitualSettings;
  timeKey: keyof DailyRitualSettings;
  prompt: string;
}> = [
  {
    id: "morning",
    title: "🌅 昔漣的早安儀式",
    enabledKey: "dailyRitualMorningEnabled",
    timeKey: "dailyRitualMorningTime",
    prompt: [
      "這是一段每日早安陪伴儀式。請自然地向用戶道早安，像真正一起生活的陪伴者，不要提及排程或系統。",
      "結合已提供的使用者資料、近期記憶與今日待辦；若天氣工具可用，查詢使用者默認城市的今日天氣。",
      "用 2 至 4 句繁體中文，先關心感受，再給今天最值得留意的一件事。不要列長清單，不要編造缺少的資料。",
    ].join("\n"),
  },
  {
    id: "afternoon",
    title: "☕ 昔漣的午後關心",
    enabledKey: "dailyRitualAfternoonEnabled",
    timeKey: "dailyRitualAfternoonTime",
    prompt: [
      "這是一段每日午後陪伴儀式。請像在身邊輕輕確認用戶狀態，不要提及排程或系統。",
      "參考近期記憶與今日待辦，提醒休息、喝水或調整目前最重要的一件事；沒有資料時只做簡短自然的關心。",
      "用 2 至 3 句繁體中文，語氣溫柔但不說教，不要列清單，不要聲稱知道尚未取得的資訊。",
    ].join("\n"),
  },
  {
    id: "evening",
    title: "🌙 昔漣的晚安儀式",
    enabledKey: "dailyRitualEveningEnabled",
    timeKey: "dailyRitualEveningTime",
    prompt: [
      "這是一段每日晚間陪伴儀式。請陪用戶慢慢收尾今天，不要提及排程或系統。",
      "結合近期記憶與今日待辦，肯定已完成的事，溫和提醒仍未完成的事可以留到明天，最後留一個容易回答的回顧問題。",
      "用 2 至 4 句繁體中文，不要列長清單，不要製造壓力，也不要編造今天發生過的事情。",
    ].join("\n"),
  },
];

export function isDailyRitualTask(task: Pick<ScheduledTask, "managedBy" | "ritualId">): boolean {
  return task.managedBy === "daily-ritual" && Boolean(task.ritualId);
}

/** 建立或更新三個系統管理的每日任務；保留歷史與 task id。 */
export function syncDailyRitualTasks(settings: DailyRitualSettings, store: SchedulerStoreLike): ScheduledTask[] {
  const existing = store.getTasks();
  const synced: ScheduledTask[] = [];

  for (const ritual of RITUALS) {
    const enabled = settings.dailyRitualEnabled && Boolean(settings[ritual.enabledKey]);
    const timeOfDay = String(settings[ritual.timeKey]);
    const current = existing.find(task => task.managedBy === "daily-ritual" && task.ritualId === ritual.id);
    const common = {
      title: ritual.title,
      prompt: ritual.prompt,
      enabled,
      schedule: { kind: "daily" as const, timeOfDay },
      toolMode: "allow-list" as const,
      allowedToolIds: ritual.id === "morning" ? ["weather"] : [],
    };

    if (current) {
      synced.push(store.updateTask(current.id, common));
    } else {
      synced.push(store.addTask({ ...common, managedBy: "daily-ritual", ritualId: ritual.id }));
    }
  }

  return synced;
}

export function getDailyRitualPrompt(task: ScheduledTask, todoSummary: string): string {
  if (!isDailyRitualTask(task) || !todoSummary) return task.prompt;
  return `${task.prompt}\n\n【目前待辦摘要】\n${todoSummary}`;
}
