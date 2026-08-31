import type { BrowserWindow } from "electron";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import { toolRegistry } from "../orchestrator/tool-registry";
import { SchedulerEngine } from "./scheduler-engine";
import { getSchedulerStore } from "./scheduler-store";
import { registerSchedulerIpc } from "./scheduler-ipc";
import { createSchedulerRunner } from "./scheduler-runner";

export interface SchedulerSubsystem {
  store: ReturnType<typeof getSchedulerStore>;
  engine: SchedulerEngine;
}

export function createSchedulerSubsystem(
  agentRuntime: AgentRuntime,
  getReactChatWindow: () => BrowserWindow | null,
): SchedulerSubsystem {
  const store = getSchedulerStore();
  store.load();

  const runner = createSchedulerRunner({
    buildOptions: (task) => agentRuntime.buildSchedulerOptions(task),
    getChatWebContents: () => {
      const win = getReactChatWindow();
      return win && !win.isDestroyed() ? win.webContents : null;
    },
    recordHistory: (entry) => store.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
  });

  const engine = new SchedulerEngine({
    store,
    runTask: runner.runScheduledTask,
  });

  registerSchedulerIpc(store, engine, () => toolRegistry.getAllTools());

  return { store, engine };
}
