import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import {
  authorizePluginTaskUpdatePatch,
  isPluginTaskEffectivelyEnabled,
  pluginTaskTogglePatch,
} from "./execution-spec";
import type { SchedulerEngine } from "./scheduler-engine";
import type { NewScheduledTaskInput, ScheduledTask, ScheduledTaskPatch, SchedulerIpcResult } from "./types";

interface SchedulerStoreLike {
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): unknown;
  updateTask(id: string, patch: ScheduledTaskPatch): unknown;
  deleteTask(id: string): boolean;
  toggleTask(id: string, enabled: boolean): unknown;
  getHistory(taskId: string, limit?: number): unknown[];
}

export interface SchedulerToolInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
}

/** 渲染层任务视图：不含授权指纹、用户授权位等宿主内部字段。 */
export type RendererScheduledTask = Omit<ScheduledTask, "approvalFingerprint" | "pluginUserEnabled">;

/**
 * 渲染层投影：插件任务的界面启停状态映射为有效授权状态
 * （用户已确认且执行规格指纹一致），与引擎实际运行判断保持同一口径。
 */
export function projectTaskForRenderer(task: ScheduledTask): RendererScheduledTask {
  const { approvalFingerprint: _fingerprint, pluginUserEnabled: _userEnabled, ...rest } = task;
  if (!task.ownerPluginId) return rest;
  return { ...rest, enabled: isPluginTaskEffectivelyEnabled(task) };
}

/** 通知所有窗口任务列表已变更 */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(IPC.SCHEDULER_CHANGED); } catch { /* ignore */ }
    }
  }
}

let schedulerIpcRegistered = false;

/** 注册 scheduler IPC。idempotent：同一 channel 重复注册会抛错。 */
export function registerSchedulerIpc(
  store: SchedulerStoreLike,
  engine: SchedulerEngine,
  getTools: () => ToolDefinition[],
  ipcOption?: IpcScope,
): void {
  if (schedulerIpcRegistered) return;
  schedulerIpcRegistered = true;
  const ipc = ipcOption ?? createIpcScope();

  const ok = <T>(value: T): SchedulerIpcResult<T> => ({ ok: true, value });
  const fail = (err: unknown): SchedulerIpcResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) });

  ipc.handle(IPC.SCHEDULER_LIST, () => ok(store.getTasks().map(projectTaskForRenderer)));
  ipc.handle(IPC.SCHEDULER_ADD, (_event, input: NewScheduledTaskInput) => {
    try { const r = ok(store.addTask(input)); broadcastChanged(); return r; } catch (err) { return fail(err); }
  });
  ipc.handle(IPC.SCHEDULER_UPDATE, (_event, id: string, patch: ScheduledTaskPatch) => {
    try {
      const current = store.getTasks().find(t => t.id === id);
      // 插件任务的保存编辑走授权转换：按保存后的规格重算指纹，剔除宿主不变量字段。
      const effective = current?.ownerPluginId
        ? authorizePluginTaskUpdatePatch(current, patch)
        : patch;
      const r = ok(store.updateTask(id, effective)); broadcastChanged(); return r;
    } catch (err) { return fail(err); }
  });
  ipc.handle(IPC.SCHEDULER_DELETE, (_event, id: string) => {
    try { const r = ok(store.deleteTask(id)); broadcastChanged(); return r; } catch (err) { return fail(err); }
  });
  ipc.handle(IPC.SCHEDULER_TOGGLE, (_event, id: string, enabled: boolean) => {
    try {
      const task = store.getTasks().find(t => t.id === id);
      // 用户任务直接写 enabled；插件任务的启停写授权位，启用时按当前规格写入指纹。
      const patch = task?.ownerPluginId
        ? pluginTaskTogglePatch(task, enabled)
        : { enabled };
      const r = ok(store.updateTask(id, patch)); broadcastChanged(); return r;
    } catch (err) { return fail(err); }
  });
  ipc.handle(IPC.SCHEDULER_GET_HISTORY, (_event, taskId: string, limit?: number) => {
    try { return ok(store.getHistory(taskId, limit)); } catch (err) { return fail(err); }
  });
  ipc.handle(IPC.SCHEDULER_FIRE_NOW, async (_event, id: string) => {
    try {
      const result = await engine.fireNow(id);
      return result.ok ? ok(true) : { ok: false, reason: result.reason };
    } catch (err) {
      return fail(err);
    }
  });
  ipc.handle(IPC.SCHEDULER_GET_TOOLS, () => ok(getTools().map(tool => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    risk: tool.risk ?? "safe",
  }))));
}
