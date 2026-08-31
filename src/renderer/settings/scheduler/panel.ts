// Scheduler 面板业务逻辑：列表渲染 / 编辑器 / 任务 CRUD
// 从 settings.ts 抽离。依赖 scheduler DOM 引用（./dom）、schedulerState（./state）、
// 纯函数（./utils）、shared showModal、scheduler/types 类型。

import type { ScheduledTask, ScheduleConfig } from "./types";
import { schedulerState } from "./state";
import {
  schedulerEmpty, schedulerList,
  schedulerEditor, schedulerEditorTitle,
  schedulerTitleInput, schedulerPromptInput, schedulerEnabledInput,
  schedulerKindInput, schedulerOnceRunAtInput, schedulerTimeOfDayInput,
  schedulerDayOfWeekInput, schedulerIntervalEveryInput, schedulerIntervalUnitInput,
  schedulerToolLimitInput, schedulerToolPicker, schedulerToolEmptyHint,
  schedulerSaveStatus,
} from "./dom";
import {
  toLocalDateTimeInputValue,
  isValidTimeOfDay,
  formatSchedulerDate,
  describeSchedule,
} from "./utils";
import { showModal } from "../shared/modal";

export function setSchedulerStatus(text: string, className = ""): void {
  if (!schedulerSaveStatus) return;
  schedulerSaveStatus.textContent = text;
  schedulerSaveStatus.className = "save-status" + (className ? " " + className : "");
}

export function renderSchedulerTools(selectedIds: string[] = []): void {
  if (!schedulerToolPicker) return;
  schedulerToolPicker.replaceChildren();
  const selected = new Set(selectedIds);
  for (const tool of schedulerState.tools) {
    const label = document.createElement("label");
    label.className = "scheduler-tool-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tool.id;
    checkbox.checked = selected.has(tool.id);
    checkbox.addEventListener("change", updateSchedulerConditionalFields);
    const copy = document.createElement("span");
    copy.textContent = `${tool.name} (${tool.id}) · ${tool.risk}${tool.enabled ? "" : " · 已全局禁用"}`;
    label.appendChild(checkbox);
    label.appendChild(copy);
    schedulerToolPicker.appendChild(label);
  }
}

export async function renderSchedulerList(): Promise<void> {
  if (!schedulerList || !schedulerEmpty) return;
  schedulerList.replaceChildren();
  schedulerEmpty.classList.toggle("is-hidden", schedulerState.tasks.length > 0);
  for (const task of schedulerState.tasks) {
    const card = document.createElement("article");
    card.className = "scheduler-card";
    card.innerHTML = `
      <div class="scheduler-card__head">
        <div class="scheduler-card__title"><span><svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><strong></strong><span class="scheduler-badge"></span></div>
      </div>
      <div class="scheduler-card__meta"></div>
      <div class="scheduler-card__actions"></div>
      <div class="scheduler-history is-hidden"></div>
    `;
    const strong = card.querySelector("strong");
    if (strong) strong.textContent = task.title;
    const badge = card.querySelector(".scheduler-badge") as HTMLSpanElement | null;
    if (badge) {
      badge.textContent = task.enabled ? "已启用" : "已停用";
      badge.classList.toggle("is-disabled", !task.enabled);
    }
    const meta = card.querySelector(".scheduler-card__meta");
    if (meta) meta.textContent = `${describeSchedule(task.schedule)} · 下次运行：${formatSchedulerDate(task.nextFireAt)} · 工具：${task.toolMode === "all-enabled" ? "全部已启用工具" : task.allowedToolIds.join(", ") || "无"}`;
    const actions = card.querySelector(".scheduler-card__actions") as HTMLDivElement | null;
    if (actions) {
      const fireBtn = document.createElement("button");
      fireBtn.type = "button";
      fireBtn.className = "ghost-btn";
      fireBtn.textContent = "立即运行";
      fireBtn.addEventListener("click", () => void fireSchedulerTask(task.id));
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost-btn";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", () => void openSchedulerEditor(task));
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "ghost-btn";
      toggleBtn.textContent = task.enabled ? "停用" : "启用";
      toggleBtn.addEventListener("click", () => void toggleSchedulerTask(task.id, !task.enabled));
      const historyBtn = document.createElement("button");
      historyBtn.type = "button";
      historyBtn.className = "ghost-btn";
      historyBtn.textContent = "历史";
      historyBtn.addEventListener("click", () => void toggleSchedulerHistory(task.id, card));
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost-btn";
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", () => void deleteSchedulerTask(task.id));
      actions.append(fireBtn, editBtn, toggleBtn, historyBtn, deleteBtn);
    }
    schedulerList.appendChild(card);
  }
}

export async function loadSchedulerPanel(): Promise<void> {
  const [tasksResult, toolsResult] = await Promise.all([
    window.cyreneScheduler!.list(),
    window.cyreneScheduler!.getTools(),
  ]);
  if (tasksResult.ok) schedulerState.tasks = tasksResult.value ?? [];
  if (toolsResult.ok) schedulerState.tools = toolsResult.value ?? [];
  renderSchedulerTools();
  await renderSchedulerList();
}

export async function openSchedulerEditor(task?: ScheduledTask): Promise<void> {
  schedulerState.editingTaskId = task?.id ?? null;
  schedulerEditor?.classList.remove("is-hidden");
  // 确保工具列表已加载
  if (schedulerState.tools.length === 0) {
    const toolsResult = await window.cyreneScheduler!.getTools();
    if (toolsResult.ok) schedulerState.tools = toolsResult.value ?? [];
  }
  if (schedulerEditorTitle) schedulerEditorTitle.textContent = task ? "编辑定时任务" : "新建定时任务";
  if (schedulerTitleInput) schedulerTitleInput.value = task?.title ?? "";
  if (schedulerPromptInput) schedulerPromptInput.value = task?.prompt ?? "";
  if (schedulerEnabledInput) schedulerEnabledInput.checked = task?.enabled ?? true;
  if (schedulerKindInput) schedulerKindInput.value = task?.schedule.kind ?? "daily";
  if (schedulerOnceRunAtInput) schedulerOnceRunAtInput.value = "";
  if (schedulerTimeOfDayInput) schedulerTimeOfDayInput.value = "08:00";
  if (schedulerDayOfWeekInput) schedulerDayOfWeekInput.value = "1";
  if (schedulerIntervalEveryInput) schedulerIntervalEveryInput.value = "1";
  if (schedulerIntervalUnitInput) schedulerIntervalUnitInput.value = "minutes";
  if (task?.schedule.kind === "once" && schedulerOnceRunAtInput) schedulerOnceRunAtInput.value = toLocalDateTimeInputValue(task.schedule.runAt);
  if ((task?.schedule.kind === "daily" || task?.schedule.kind === "weekly") && schedulerTimeOfDayInput) schedulerTimeOfDayInput.value = task.schedule.timeOfDay;
  if (task?.schedule.kind === "weekly" && schedulerDayOfWeekInput) schedulerDayOfWeekInput.value = String(task.schedule.dayOfWeek);
  if (task?.schedule.kind === "interval") {
    if (schedulerIntervalEveryInput) schedulerIntervalEveryInput.value = String(task.schedule.every);
    if (schedulerIntervalUnitInput) schedulerIntervalUnitInput.value = task.schedule.unit;
  }
  if (schedulerToolLimitInput) schedulerToolLimitInput.checked = task?.toolMode === "allow-list";
  renderSchedulerTools(task?.allowedToolIds ?? []);
  updateSchedulerConditionalFields();
  setSchedulerStatus("等待操作");
}

export function closeSchedulerEditor(): void {
  schedulerState.editingTaskId = null;
  schedulerEditor?.classList.add("is-hidden");
}

export function updateSchedulerConditionalFields(): void {
  const kind = schedulerKindInput?.value ?? "daily";
  document.querySelectorAll(".scheduler-once-field").forEach(el => el.classList.toggle("is-hidden", kind !== "once"));
  document.querySelectorAll(".scheduler-time-field").forEach(el => el.classList.toggle("is-hidden", kind !== "daily" && kind !== "weekly"));
  document.querySelectorAll(".scheduler-weekly-field").forEach(el => el.classList.toggle("is-hidden", kind !== "weekly"));
  document.querySelectorAll(".scheduler-interval-field").forEach(el => el.classList.toggle("is-hidden", kind !== "interval"));
  const allowListEnabled = Boolean(schedulerToolLimitInput?.checked);
  schedulerToolPicker?.classList.toggle("is-hidden", !allowListEnabled);
  const selectedCount = collectAllowedToolIds().length;
  schedulerToolEmptyHint?.classList.toggle("is-hidden", !allowListEnabled || selectedCount > 0);
}

export function collectSchedule(): ScheduleConfig {
  const kind = schedulerKindInput?.value ?? "daily";
  if (kind === "once") {
    const value = schedulerOnceRunAtInput?.value;
    if (!value) throw new Error("请选择一次性运行时间");
    const runAt = new Date(value);
    if (Number.isNaN(runAt.getTime())) throw new Error("一次性运行时间无效");
    if (runAt.getTime() <= Date.now()) throw new Error("一次性任务时间必须晚于当前时间");
    return { kind: "once", runAt: runAt.toISOString() };
  }
  if (kind === "weekly") {
    const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
    if (!isValidTimeOfDay(timeOfDay)) throw new Error("每周时间格式必须是 HH:mm");
    const dayOfWeek = Number(schedulerDayOfWeekInput?.value ?? 1);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error("星期必须是周一到周日");
    return { kind: "weekly", dayOfWeek: dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay };
  }
  if (kind === "interval") {
    const every = Number(schedulerIntervalEveryInput?.value ?? 1);
    const unit = schedulerIntervalUnitInput?.value === "hours" ? "hours" : "minutes";
    if (!Number.isInteger(every) || every <= 0) throw new Error("间隔必须是正整数");
    if (unit === "minutes" && every > 1440) throw new Error("分钟间隔不能超过 1440");
    if (unit === "hours" && every > 168) throw new Error("小时间隔不能超过 168");
    return { kind: "interval", every, unit };
  }
  const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
  if (!isValidTimeOfDay(timeOfDay)) throw new Error("每日时间格式必须是 HH:mm");
  return { kind: "daily", timeOfDay };
}

export function collectAllowedToolIds(): string[] {
  if (!schedulerToolPicker) return [];
  return Array.from(schedulerToolPicker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value);
}

export async function saveSchedulerTask(): Promise<void> {
  try {
    setSchedulerStatus("保存中…");
    const title = (schedulerTitleInput?.value ?? "").trim();
    const prompt = (schedulerPromptInput?.value ?? "").trim();
    if (!title) throw new Error("标题不能为空");
    if (!prompt) throw new Error("提示词不能为空");
    const input = {
      title,
      prompt,
      enabled: schedulerEnabledInput?.checked ?? true,
      schedule: collectSchedule(),
      toolMode: schedulerToolLimitInput?.checked ? "allow-list" : "all-enabled",
      allowedToolIds: collectAllowedToolIds(),
    };
    const result = schedulerState.editingTaskId
      ? await window.cyreneScheduler!.update(schedulerState.editingTaskId, input)
      : await window.cyreneScheduler!.add(input);
    if (!result.ok) throw new Error(result.error ?? "保存失败");
    await loadSchedulerPanel();
    closeSchedulerEditor();
  } catch (err) {
    setSchedulerStatus(err instanceof Error ? err.message : String(err), "is-error");
  }
}

export async function toggleSchedulerTask(id: string, enabled: boolean): Promise<void> {
  const result = await window.cyreneScheduler!.toggle(id, enabled);
  if (!result.ok) window.alert(result.error ?? "切换失败");
  await loadSchedulerPanel();
}

export async function fireSchedulerTask(id: string): Promise<void> {
  const result = await window.cyreneScheduler!.fireNow(id);
  if (!result.ok) window.alert(result.reason === "task already running" ? "该任务正在运行中" : (result.error ?? result.reason ?? "立即运行失败"));
}

export async function deleteSchedulerTask(id: string): Promise<void> {
  const ok = await showModal({ title: "删除定时任务", message: "确定删除这个定时任务吗？", icon: '<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-2px"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 15H40L37 44H11L8 15Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M20.002 25.0024V35.0026" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M28.0024 24.9995V34.9972" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 14.9999L28.3242 3L36 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>', confirmText: "删除" });
  if (!ok) return;
  const result = await window.cyreneScheduler!.delete(id);
  if (!result.ok) window.alert(result.error ?? "删除失败");
  await loadSchedulerPanel();
}

export async function toggleSchedulerHistory(taskId: string, card: Element): Promise<void> {
  const box = card.querySelector(".scheduler-history") as HTMLDivElement | null;
  if (!box) return;
  if (!box.classList.contains("is-hidden")) {
    box.classList.add("is-hidden");
    return;
  }
  const result = await window.cyreneScheduler!.getHistory(taskId, 10);
  const rows = result.value ?? [];
  box.replaceChildren();
  if (!result.ok || rows.length === 0) {
    box.textContent = result.ok ? "暂无运行历史" : (result.error ?? "读取历史失败");
  } else {
    for (const row of rows) {
      const div = document.createElement("div");
      div.textContent = `${formatSchedulerDate(row.firedAt)} ${row.status}${row.durationMs ? ` ${Math.round(row.durationMs / 100) / 10}s` : ""}：${row.outputPreview ?? row.errorMessage ?? row.reason ?? ""}`;
      box.appendChild(div);
    }
  }
  box.classList.remove("is-hidden");
}
