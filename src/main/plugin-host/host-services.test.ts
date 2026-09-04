import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createHostServiceFactory } from "./host-services";
import type { PluginSchedulerStore } from "./scheduler-service";
import type { SafeStorageLike } from "./secrets-service";

const fakeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
  decryptString: (encrypted) => encrypted.toString("utf8").slice(4),
};

const reader = {
  listSessions: () => [],
  getSession: () => null,
  getWorkspaceBinding: () => undefined,
};

/** 内存版调度存储假件：真实行为由 scheduler-store 测试覆盖。 */
function fakeSchedulerStore(): PluginSchedulerStore {
  const tasks: ReturnType<PluginSchedulerStore["getTasks"]> = [];
  return {
    getTasks: () => tasks,
    addTask: (input) => {
      const task = {
        id: `task-${tasks.length + 1}`,
        title: input.title,
        prompt: input.prompt,
        enabled: false,
        schedule: input.schedule,
        nextFireAt: null,
        toolMode: "allow-list",
        allowedToolIds: input.allowedToolIds,
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
        ownerPluginId: input.ownerPluginId,
        pluginUserEnabled: false,
        approvalFingerprint: "",
        mode: input.mode,
      };
      tasks.push(task);
      return task;
    },
    updateTask: (id, patch) => {
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) throw new Error("missing task");
      tasks[index] = { ...tasks[index], ...patch };
      return tasks[index];
    },
    deleteTask: (id) => {
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) return false;
      tasks.splice(index, 1);
      return true;
    },
    getHistory: () => [],
  };
}

let tmp: string;
let schedulerStore: PluginSchedulerStore;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-host-services-"));
  schedulerStore = fakeSchedulerStore();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function factory() {
  return createHostServiceFactory({
    pluginDataRoot: tmp,
    channelManager: { has: (id) => id === "builtin" },
    llm: { generateText: async () => "llm-result" },
    storage: fakeStorage,
    chatsReader: reader,
    schedulerStore,
  });
}

describe("宿主服务装配工厂", () => {
  it("为每个插件生成完整服务集合，密钥目录按插件隔离", async () => {
    const hostServices = factory();
    const a = hostServices.createForPlugin({ pluginId: "plugin-a", signal: new AbortController().signal, trackResource: undefined as never });
    const b = hostServices.createForPlugin({ pluginId: "plugin-b", signal: new AbortController().signal, trackResource: undefined as never });

    expect(a.channels?.has("builtin")).toBe(true);
    expect(a.channels?.has("other")).toBe(false);
    expect(await a.llm?.generateText([{ role: "user", content: "hi" }])).toBe("llm-result");

    await a.secrets?.set("key", "a-value");
    expect(await a.secrets?.get("key")).toBe("a-value");
    // plugin-b 的密钥在独立目录，读不到 plugin-a 的值
    expect(await b.secrets?.get("key")).toBeUndefined();
    expect(existsSync(path.join(tmp, "plugin-a", "secrets"))).toBe(true);
    expect(readdirSync(path.join(tmp, "plugin-a", "secrets"))).toHaveLength(1);

    expect(await a.workspace?.getBinding("conv-1")).toBeNull();
    const listPage = await a.conversations?.list();
    expect(listPage?.items).toEqual([]);

    // scheduler 服务已装配且能创建任务（新任务必然处于停用状态等待用户授权）
    const created = await a.scheduler?.createTask({
      title: "每日摘要",
      prompt: "总结今天",
      schedule: { kind: "daily", timeOfDay: "09:00" },
      mode: "work",
      allowedToolIds: [],
    });
    expect(created?.enabled).toBe(false);
    const bList = await b.scheduler?.listTasks();
    expect(bList).toEqual([]);
  });

  it("插件停止信号传导到各服务", async () => {
    const controller = new AbortController();
    const deps = factory().createForPlugin({
      pluginId: "plugin-a",
      signal: controller.signal,
      trackResource: undefined as never,
    });
    controller.abort();
    await expect(deps.secrets?.get("key")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
    await expect(deps.conversations?.list()).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
    await expect(deps.workspace?.getBinding("conv-1")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
    await expect(deps.scheduler?.listTasks()).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
  });
});
