import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { computeInitialNextFireAt, normalizeOverdueNextFireAt } from "./schedule-calculator";
import type { PluginPromptMode } from "../../plugins/api";
import type {
  NewScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskHistoryEntry,
  ScheduledTaskPatch,
  ScheduleConfig,
  SchedulerToolMode,
} from "./types";

interface StoreDeps {
  tasksFile: string;
  historyFile: string;
  now: () => Date;
  id: () => string;
}

function defaultDeps(): StoreDeps {
  return {
    tasksFile: path.join(app.getPath("userData"), "scheduled-tasks.json"),
    historyFile: path.join(app.getPath("userData"), "scheduled-tasks-history.jsonl"),
    now: () => new Date(),
    id: () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map(v => String(v).trim()).filter(Boolean)));
}

function validateTimeOfDay(timeOfDay: string, label: string): void {
  const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay);
  if (!match) throw new Error(`${label}格式必须是 HH:mm`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`${label}必须是有效时间`);
  }
}

/** 供插件调度服务在调用 store 前做同样的结构校验。 */
export function validateSchedule(schedule: ScheduleConfig): void {
  if (!schedule || typeof schedule !== "object") throw new Error("缺少调度配置");
  if (schedule.kind === "daily") {
    validateTimeOfDay(schedule.timeOfDay, "每日时间");
  } else if (schedule.kind === "weekly") {
    if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) {
      throw new Error("星期必须是 0-6");
    }
    validateTimeOfDay(schedule.timeOfDay, "每周时间");
  } else if (schedule.kind === "interval") {
    if (!Number.isInteger(schedule.every) || schedule.every <= 0) throw new Error("间隔必须是正整数");
    if (schedule.unit === "minutes" && schedule.every > 1440) throw new Error("分钟间隔不能超过 1440");
    if (schedule.unit === "hours" && schedule.every > 168) throw new Error("小时间隔不能超过 168");
    if (schedule.unit !== "minutes" && schedule.unit !== "hours") throw new Error("间隔单位无效");
  } else if (schedule.kind === "once") {
    const runAt = new Date(schedule.runAt);
    if (Number.isNaN(runAt.getTime())) throw new Error("一次性运行时间无效");
  } else {
    throw new Error("未知调度类型");
  }
}

function normalizeToolMode(value: unknown): SchedulerToolMode {
  return value === "allow-list" ? "allow-list" : "all-enabled";
}

function normalizeMode(value: unknown): PluginPromptMode | undefined {
  return value === "chat" || value === "work" || value === "learn" || value === "code" ? value : undefined;
}

function normalizeLoadedTask(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== "object") return null;
  const task = raw as Partial<ScheduledTask>;
  if (typeof task.id !== "string" || !task.id.trim()) return null;
  if (typeof task.title !== "string" || typeof task.prompt !== "string") return null;
  if (!task.schedule) return null;
  try { validateSchedule(task.schedule); } catch { return null; }
  const ownerPluginId = typeof task.ownerPluginId === "string" && task.ownerPluginId.trim()
    ? task.ownerPluginId
    : undefined;
  return {
    id: task.id,
    title: task.title.trim(),
    prompt: task.prompt.trim(),
    // 插件任务的磁盘 enabled 永远归一化为 false：旧版宿主可能把它当普通任务
    // 手动启用过，升级后必须回到停用，等用户重新确认授权。
    enabled: ownerPluginId ? false : task.enabled !== false,
    schedule: task.schedule,
    nextFireAt: typeof task.nextFireAt === "string" ? task.nextFireAt : null,
    lastFiredAt: typeof task.lastFiredAt === "string" ? task.lastFiredAt : undefined,
    toolMode: ownerPluginId ? "allow-list" : normalizeToolMode(task.toolMode),
    allowedToolIds: uniq(Array.isArray(task.allowedToolIds) ? task.allowedToolIds : []),
    createdAt: typeof task.createdAt === "string" ? task.createdAt : new Date(0).toISOString(),
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : new Date(0).toISOString(),
    ...(ownerPluginId ? {
      ownerPluginId,
      pluginUserEnabled: task.pluginUserEnabled === true,
      mode: normalizeMode(task.mode),
      approvalFingerprint: typeof task.approvalFingerprint === "string" ? task.approvalFingerprint : "",
    } : {}),
  };
}

export function createSchedulerStore(deps: StoreDeps) {
  let tasks: ScheduledTask[] = [];
  let listeners: Array<(next: ScheduledTask[]) => void> = [];

  function persistTasks(): void {
    ensureParent(deps.tasksFile);
    fs.writeFileSync(deps.tasksFile, JSON.stringify({ tasks }, null, 2), "utf8");
  }

  function notify(): void {
    const snapshot = tasks.map(t => ({ ...t, allowedToolIds: [...t.allowedToolIds] }));
    for (const listener of listeners) {
      try { listener(snapshot); } catch (err) { console.warn("[SchedulerStore] listener failed:", err); }
    }
  }

  function load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(deps.tasksFile, "utf8")) as { tasks?: unknown[] };
      tasks = Array.isArray(parsed.tasks)
        ? parsed.tasks.map(normalizeLoadedTask).filter((task): task is ScheduledTask => task !== null)
        : [];
    } catch {
      tasks = [];
    }
  }

  function getTasks(): ScheduledTask[] {
    return tasks.map(t => ({ ...t, allowedToolIds: [...t.allowedToolIds] }));
  }

  function nextTaskId(): string {
    const existing = new Set(tasks.map(task => task.id));
    let candidate = deps.id();
    let counter = 1;
    while (existing.has(candidate)) {
      candidate = `${deps.id()}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  function addTask(input: NewScheduledTaskInput): ScheduledTask {
    const title = String(input.title ?? "").trim();
    const prompt = String(input.prompt ?? "").trim();
    if (!title) throw new Error("标题不能为空");
    if (!prompt) throw new Error("提示词不能为空");
    validateSchedule(input.schedule);
    if (input.mode !== undefined && normalizeMode(input.mode) === undefined) throw new Error("会话模式无效");
    const now = deps.now();
    const next = computeInitialNextFireAt(input.schedule, now);
    if (input.schedule.kind === "once" && !next) throw new Error("一次性任务时间必须晚于当前时间");
    const ownerPluginId = typeof input.ownerPluginId === "string" && input.ownerPluginId.trim()
      ? input.ownerPluginId
      : undefined;
    const task: ScheduledTask = {
      id: nextTaskId(),
      title,
      prompt,
      // 插件任务不接受 enabled 输入：永远以 false 落盘，运行授权由 pluginUserEnabled 表达。
      enabled: ownerPluginId ? false : (input.enabled ?? true),
      schedule: input.schedule,
      nextFireAt: next ? next.toISOString() : null,
      toolMode: ownerPluginId ? "allow-list" : normalizeToolMode(input.toolMode),
      allowedToolIds: uniq(input.allowedToolIds ?? []),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(ownerPluginId ? {
        ownerPluginId,
        pluginUserEnabled: input.pluginUserEnabled === true,
        mode: normalizeMode(input.mode),
        approvalFingerprint: typeof input.approvalFingerprint === "string" ? input.approvalFingerprint : "",
      } : {}),
    };
    tasks = [...tasks, task];
    persistTasks();
    notify();
    return { ...task, allowedToolIds: [...task.allowedToolIds] };
  }

  function updateTask(id: string, patch: ScheduledTaskPatch): ScheduledTask {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx < 0) throw new Error("任务不存在");
    const current = tasks[idx];
    const isPluginTask = current.ownerPluginId !== undefined;
    const now = deps.now();
    const schedule = patch.schedule ?? current.schedule;
    validateSchedule(schedule);
    if (patch.mode !== undefined && normalizeMode(patch.mode) === undefined) throw new Error("会话模式无效");
    const title = patch.title !== undefined ? String(patch.title).trim() : current.title;
    const prompt = patch.prompt !== undefined ? String(patch.prompt).trim() : current.prompt;
    if (!title) throw new Error("标题不能为空");
    if (!prompt) throw new Error("提示词不能为空");
    const scheduleChanged = patch.schedule !== undefined;
    // 用户任务看 enabled；插件任务的启用入口是 pluginUserEnabled（用户确认授权）。
    const enabling = !isPluginTask && patch.enabled === true && current.enabled === false;
    const pluginEnabling = isPluginTask && patch.pluginUserEnabled === true && current.pluginUserEnabled !== true;
    const hasExplicitNextFireAt = Object.prototype.hasOwnProperty.call(patch, "nextFireAt");
    let next = hasExplicitNextFireAt
      ? (patch.nextFireAt ? new Date(patch.nextFireAt) : null)
      : (scheduleChanged ? computeInitialNextFireAt(schedule, now) : (current.nextFireAt ? new Date(current.nextFireAt) : null));
    if (next && Number.isNaN(next.getTime())) next = null;
    if (schedule.kind === "once" && scheduleChanged && !next) throw new Error("一次性任务时间必须晚于当前时间");
    if (enabling || pluginEnabling) {
      if (!next || Number.isNaN(next.getTime())) {
        next = computeInitialNextFireAt(schedule, now);
      } else if (next.getTime() <= now.getTime()) {
        next = normalizeOverdueNextFireAt(schedule, next, now);
      }
      if (schedule.kind === "once" && (!next || next.getTime() <= now.getTime())) {
        next = null;
      }
    }
    const updated: ScheduledTask = {
      ...current,
      ...patch,
      title,
      prompt,
      schedule,
      nextFireAt: next ? next.toISOString() : null,
      // 插件任务的 enabled 与 toolMode 是宿主不变量：任何 patch 都改不掉。
      enabled: isPluginTask ? false : (patch.enabled ?? current.enabled),
      toolMode: isPluginTask ? "allow-list" : normalizeToolMode(patch.toolMode ?? current.toolMode),
      allowedToolIds: patch.allowedToolIds ? uniq(patch.allowedToolIds) : [...current.allowedToolIds],
      updatedAt: now.toISOString(),
    };
    tasks = [...tasks.slice(0, idx), updated, ...tasks.slice(idx + 1)];
    persistTasks();
    notify();
    return { ...updated, allowedToolIds: [...updated.allowedToolIds] };
  }

  function deleteTask(id: string): boolean {
    const before = tasks.length;
    tasks = tasks.filter(t => t.id !== id);
    if (tasks.length === before) return false;
    persistTasks();
    notify();
    return true;
  }

  /**
   * 删除某插件拥有的全部任务。仅在用户真正卸载该插件时调用，
   * 避免插件程序目录已删除但任务仍在定时产生外部副作用。
   */
  function deleteTasksByOwner(pluginId: string): number {
    const before = tasks.length;
    tasks = tasks.filter(t => t.ownerPluginId !== pluginId);
    if (tasks.length === before) return 0;
    persistTasks();
    notify();
    return before - tasks.length;
  }

  function toggleTask(id: string, enabled: boolean): ScheduledTask {
    return updateTask(id, { enabled });
  }

  function readAllHistory(): ScheduledTaskHistoryEntry[] {
    try {
      return fs.readFileSync(deps.historyFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as ScheduledTaskHistoryEntry)
        .filter(item => item && typeof item.taskId === "string");
    } catch {
      return [];
    }
  }

  function recordHistory(entry: ScheduledTaskHistoryEntry): void {
    ensureParent(deps.historyFile);
    const existing = readAllHistory().filter(item => item.id !== entry.id);
    existing.push(entry);
    const grouped = new Map<string, ScheduledTaskHistoryEntry[]>();
    for (const item of existing) {
      const group = grouped.get(item.taskId) ?? [];
      group.push(item);
      grouped.set(item.taskId, group);
    }
    const compacted = Array.from(grouped.values())
      .flatMap(group => group.sort((a, b) => a.firedAt.localeCompare(b.firedAt)).slice(-50))
      .sort((a, b) => a.firedAt.localeCompare(b.firedAt))
      .slice(-1000);
    fs.writeFileSync(deps.historyFile, compacted.map(item => JSON.stringify(item)).join("\n") + (compacted.length ? "\n" : ""), "utf8");
  }

  function getHistory(taskId: string, limit = 10): ScheduledTaskHistoryEntry[] {
    return readAllHistory()
      .filter(item => item.taskId === taskId)
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      .slice(0, limit);
  }

  function onChange(listener: (next: ScheduledTask[]) => void): () => void {
    listeners.push(listener);
    return () => { listeners = listeners.filter(l => l !== listener); };
  }

  return { load, getTasks, addTask, updateTask, deleteTask, deleteTasksByOwner, toggleTask, recordHistory, getHistory, onChange };
}

let defaultStore: ReturnType<typeof createSchedulerStore> | null = null;

export function getSchedulerStore(): ReturnType<typeof createSchedulerStore> {
  if (!defaultStore) defaultStore = createSchedulerStore(defaultDeps());
  return defaultStore;
}
