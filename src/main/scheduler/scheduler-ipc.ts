import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import type { SchedulerEngine } from "./scheduler-engine";
import type { NewScheduledTaskInput, ScheduledTaskPatch, SchedulerIpcResult } from "./types";

interface SchedulerStoreLike {
  getTasks(): unknown[];
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

/** 通知所有窗口任务列表已变更 */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(IPC.SCHEDULER_CHANGED); } catch { /* ignore */ }
    }
  }
}

export function registerSchedulerIpc(
  store: SchedulerStoreLike,
  engine: SchedulerEngine,
  getTools: () => ToolDefinition[],
): void {
  const ok = <T>(value: T): SchedulerIpcResult<T> => ({ ok: true, value });
  const fail = (err: unknown): SchedulerIpcResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) });

  ipcMain.handle(IPC.SCHEDULER_LIST, () => ok(store.getTasks()));
  ipcMain.handle(IPC.SCHEDULER_ADD, (_event, input: NewScheduledTaskInput) => {
    try { const r = ok(store.addTask(input)); broadcastChanged(); return r; } catch (err) { return fail(err); }
  });
  ipcMain.handle(IPC.SCHEDULER_UPDATE, (_event, id: string, patch: ScheduledTaskPatch) => {
    try { const r = ok(store.updateTask(id, patch)); broadcastChanged(); return r; } catch (err) { return fail(err); }
  });
  ipcMain.handle(IPC.SCHEDULER_DELETE, (_event, id: string) => {
    try { const r = ok(store.deleteTask(id)); broadcastChanged(); return r; } catch (err) { return fail(err); }
  });
  ipcMain.handle(IPC.SCHEDULER_TOGGLE, (_event, id: string, enabled: boolean) => {
    try { const r = ok(store.toggleTask(id, enabled)); broadcastChanged(); return r; } catch (err) { return fail(err); }
  });
  ipcMain.handle(IPC.SCHEDULER_GET_HISTORY, (_event, taskId: string, limit?: number) => {
    try { return ok(store.getHistory(taskId, limit)); } catch (err) { return fail(err); }
  });
  ipcMain.handle(IPC.SCHEDULER_FIRE_NOW, async (_event, id: string) => {
    try {
      const result = await engine.fireNow(id);
      return result.ok ? ok(true) : { ok: false, reason: result.reason };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle(IPC.SCHEDULER_GET_TOOLS, () => ok(getTools().map(tool => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    risk: tool.risk ?? "safe",
  }))));
}
