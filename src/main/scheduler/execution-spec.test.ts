import { describe, expect, it } from "vitest";
import {
  authorizePluginTaskUpdatePatch,
  computeExecutionSpecFingerprint,
  isPluginTaskEffectivelyEnabled,
  isTaskEnabled,
  pluginTaskTogglePatch,
  taskExecutionSpec,
} from "./execution-spec";
import type { ScheduledTask } from "./types";

const baseSpec = {
  schedule: { kind: "daily", timeOfDay: "09:00" },
  prompt: "总结今天",
  mode: "work" as const,
  allowedToolIds: ["weather", "calendar"],
};

function pluginTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "每日总结",
    prompt: baseSpec.prompt,
    enabled: false,
    schedule: baseSpec.schedule,
    nextFireAt: "2026-06-23T01:00:00.000Z",
    toolMode: "allow-list",
    allowedToolIds: baseSpec.allowedToolIds,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    ownerPluginId: "demo-plugin",
    pluginUserEnabled: false,
    approvalFingerprint: "",
    mode: "work",
    ...overrides,
  };
}

describe("执行规格指纹", () => {
  it("同样语义的规格指纹一致", () => {
    const a = computeExecutionSpecFingerprint({ ...baseSpec });
    const b = computeExecutionSpecFingerprint({
      schedule: { timeOfDay: "09:00", kind: "daily" },
      prompt: "总结今天",
      mode: "work",
      allowedToolIds: ["calendar", "weather"],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("工具 ID 顺序不同、重复项不影响指纹", () => {
    expect(
      computeExecutionSpecFingerprint({ ...baseSpec, allowedToolIds: ["calendar", "weather", "weather"] }),
    ).toBe(computeExecutionSpecFingerprint({ ...baseSpec }));
  });

  it("任一执行规格字段变化都会改变指纹，标题不属于执行规格", () => {
    const base = computeExecutionSpecFingerprint({ ...baseSpec });
    expect(computeExecutionSpecFingerprint({ ...baseSpec, prompt: "别的提示词" })).not.toBe(base);
    expect(computeExecutionSpecFingerprint({ ...baseSpec, mode: "chat" })).not.toBe(base);
    expect(computeExecutionSpecFingerprint({ ...baseSpec, allowedToolIds: ["weather"] })).not.toBe(base);
    expect(
      computeExecutionSpecFingerprint({ ...baseSpec, schedule: { kind: "daily", timeOfDay: "09:30" } }),
    ).not.toBe(base);
    // 标题改了指纹不变（标题不参与计算）
    expect(computeExecutionSpecFingerprint({ ...baseSpec })).toBe(base);
  });

  it("旧任务缺 mode 时按 work 归一化", () => {
    const withoutMode = pluginTask({ mode: undefined });
    expect(taskExecutionSpec(withoutMode).mode).toBe("work");
    expect(taskExecutionSpec(pluginTask({ mode: "chat" })).mode).toBe("chat");
  });
});

describe("插件任务有效启用状态", () => {
  it("未授权或无指纹时一律视为停用", () => {
    const fingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(pluginTask()));
    expect(isPluginTaskEffectivelyEnabled(pluginTask())).toBe(false);
    expect(isPluginTaskEffectivelyEnabled(pluginTask({ pluginUserEnabled: true }))).toBe(false);
    expect(isPluginTaskEffectivelyEnabled(pluginTask({ approvalFingerprint: fingerprint }))).toBe(false);
  });

  it("用户已授权且指纹匹配时视为启用", () => {
    const task = pluginTask();
    const fingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(task));
    expect(
      isPluginTaskEffectivelyEnabled(pluginTask({ pluginUserEnabled: true, approvalFingerprint: fingerprint })),
    ).toBe(true);
  });

  it("规格变化后旧指纹不再匹配", () => {
    const task = pluginTask();
    const fingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(task));
    const changed = pluginTask({
      pluginUserEnabled: true,
      approvalFingerprint: fingerprint,
      prompt: "被插件改过的提示词",
    });
    expect(isPluginTaskEffectivelyEnabled(changed)).toBe(false);
  });

  it("用户任务一律返回 false（不走本判定）", () => {
    const userTask = pluginTask({ ownerPluginId: undefined, pluginUserEnabled: undefined, enabled: true });
    expect(isPluginTaskEffectivelyEnabled(userTask)).toBe(false);
  });
});

describe("统一任务启用判断 isTaskEnabled", () => {
  it("用户任务直接看磁盘 enabled", () => {
    const userTask = pluginTask({
      ownerPluginId: undefined,
      pluginUserEnabled: undefined,
      approvalFingerprint: undefined,
    });
    expect(isTaskEnabled(userTask)).toBe(false);
    expect(isTaskEnabled(pluginTask({ ownerPluginId: undefined, pluginUserEnabled: undefined, enabled: true }))).toBe(true);
  });

  it("插件任务看有效授权，无视 enabled 字段", () => {
    const fingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(pluginTask()));
    // 插件任务永远以 enabled:false 落盘，enabled 字段不参与判断
    expect(isTaskEnabled(pluginTask({ pluginUserEnabled: true, approvalFingerprint: fingerprint }))).toBe(true);
    expect(isTaskEnabled(pluginTask({ pluginUserEnabled: true, approvalFingerprint: fingerprint, enabled: true }))).toBe(true);
    expect(isTaskEnabled(pluginTask({ pluginUserEnabled: false, approvalFingerprint: fingerprint }))).toBe(false);
  });
});

describe("渲染层启停插件任务的 patch 转换", () => {
  it("启用时写入当前规格的授权指纹，停用时只清授权位", () => {
    const task = pluginTask();
    const enable = pluginTaskTogglePatch(task, true);
    expect(enable.pluginUserEnabled).toBe(true);
    expect(enable.approvalFingerprint).toBe(computeExecutionSpecFingerprint(taskExecutionSpec(task)));

    const disable = pluginTaskTogglePatch(task, false);
    expect(disable).toEqual({ pluginUserEnabled: false });
  });

  it("启用后写入的指纹与引擎执行前重算的结果一致", () => {
    const task = pluginTask();
    const enable = pluginTaskTogglePatch(task, true);
    const authorized = pluginTask({
      pluginUserEnabled: enable.pluginUserEnabled,
      approvalFingerprint: enable.approvalFingerprint,
    });
    expect(isPluginTaskEffectivelyEnabled(authorized)).toBe(true);
  });
});

describe("渲染层保存插件任务编辑的授权转换", () => {
  it("明确启用时按合并后的新规格重算指纹", () => {
    const task = pluginTask();
    const patch = authorizePluginTaskUpdatePatch(task, {
      prompt: "新提示词",
      pluginUserEnabled: true,
      enabled: true,
      toolMode: "all-enabled",
    });
    expect(patch.pluginUserEnabled).toBe(true);
    expect(patch.approvalFingerprint).toBe(
      computeExecutionSpecFingerprint(taskExecutionSpec({ ...task, prompt: "新提示词" })),
    );
    // enabled 与 toolMode 是宿主不变量，从 patch 中剔除
    expect(patch.enabled).toBeUndefined();
    expect(patch.toolMode).toBeUndefined();
  });

  it("已授权任务被编辑保存时视为再次确认，授权保持有效", () => {
    const fingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(pluginTask()));
    const authorized = pluginTask({ pluginUserEnabled: true, approvalFingerprint: fingerprint });
    const patch = authorizePluginTaskUpdatePatch(authorized, { schedule: { kind: "daily", timeOfDay: "10:00" } });
    expect(patch.pluginUserEnabled).toBe(true);
    expect(patch.approvalFingerprint).toBe(
      computeExecutionSpecFingerprint(taskExecutionSpec({ ...authorized, schedule: { kind: "daily", timeOfDay: "10:00" } })),
    );
  });

  it("未授权任务编辑保存且未明确启用时保持未授权", () => {
    const task = pluginTask();
    const patch = authorizePluginTaskUpdatePatch(task, { prompt: "新提示词" });
    expect(patch.pluginUserEnabled).toBeUndefined();
    expect(patch.approvalFingerprint).toBeUndefined();
  });

  it("明确停用时撤销授权", () => {
    const fingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(pluginTask()));
    const authorized = pluginTask({ pluginUserEnabled: true, approvalFingerprint: fingerprint });
    const patch = authorizePluginTaskUpdatePatch(authorized, { pluginUserEnabled: false });
    expect(patch.pluginUserEnabled).toBe(false);
  });

  it("编辑保存合并 patch 与现有规格后，mode 变化会反映进指纹", () => {
    const task = pluginTask({ mode: "work" });
    const patch = authorizePluginTaskUpdatePatch(task, { mode: "chat", pluginUserEnabled: true });
    expect(patch.approvalFingerprint).toBe(
      computeExecutionSpecFingerprint(taskExecutionSpec({ ...task, mode: "chat" })),
    );
  });
});
