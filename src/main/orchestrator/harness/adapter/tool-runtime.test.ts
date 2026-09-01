import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, checkPermission, createTaskExecutor, taskStore, toolOutputStore, leaseAllows } = vi.hoisted(() => ({
  getById: vi.fn(),
  checkPermission: vi.fn(),
  createTaskExecutor: vi.fn(() => ({ execute: vi.fn() })),
  taskStore: vi.fn(),
  toolOutputStore: vi.fn(),
  leaseAllows: vi.fn(),
}));

vi.mock("../../tools/registry/tool-registry", () => ({ toolRegistry: { getById } }));
vi.mock("../../../permission", () => ({ checkPermission }));
vi.mock("../../plan-mode", () => ({ isPlanReadOnly: vi.fn(() => false) }));
vi.mock("../../task-runtime", () => ({ createTaskExecutor }));
vi.mock("../../../tasks/task-session-store", () => ({ TaskSessionStore: taskStore }));
vi.mock("../tool-output/file-tool-output-store", () => ({ FileToolOutputStore: toolOutputStore }));
vi.mock("./event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "C:\\cyrene-runtime") } }));
vi.mock("../../../capability-leases/lease-store", () => ({
  capabilityLeaseStore: { allows: leaseAllows },
}));

import { prepareToolRuntime } from "./tool-runtime";

describe("harness tool runtime", () => {
  beforeEach(() => {
    getById.mockReset();
    checkPermission.mockReset();
    leaseAllows.mockReset();
    createTaskExecutor.mockClear();
    checkPermission.mockResolvedValue({ allowed: true });
    getById.mockReturnValue({
      id: "read_file",
      name: "Read File",
      description: "reads a file",
      risk: "safe",
    });
  });

  it("uses one signal for context, permission, and task execution", async () => {
    const controller = new AbortController();
    const clarify = vi.fn(async () => ({ answers: [] }));
    const runtime = prepareToolRuntime({
      options: {
        conversationId: "thread-1",
        conversationMode: "work",
        settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
        messages: [{ role: "user", content: "读文件" }],
        requestUserClarification: clarify,
        permissionMode: "prompt",
      } as never,
      signal: controller.signal,
      prepared: {
        threadId: "thread-1",
        runId: "run-1",
        systemPrompt: "system",
        vendorConfig: {},
        tools: [],
        runStore: {},
      } as never,
      sendBaseEvent: vi.fn(),
    });

    expect(runtime.toolContext.signal).toBe(controller.signal);
    await runtime.checkPermission("read_file", { path: "x" });
    expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      signal: controller.signal,
    }));
    await runtime.taskExecutor;
    expect(createTaskExecutor).toHaveBeenCalledWith(expect.objectContaining({
      parent: expect.objectContaining({ signal: controller.signal }),
    }));
  });

  it("租约工具按插件、run 与参数精确匹配，allow_all 也不能绕过", async () => {
    getById.mockReturnValue({
      id: "computer_use_click",
      name: "Click",
      description: "clicks a point",
      risk: "input-control",
      capability: "computer-use",
      ownerPluginId: "computer-use",
      permissionLease: { scopeArgs: ["sessionId"] },
    });
    leaseAllows.mockReturnValue(true);
    const runtime = prepareToolRuntime({
      options: {
        conversationId: "thread-1",
        conversationMode: "work",
        settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
        messages: [{ role: "user", content: "点击" }],
        requestUserClarification: vi.fn(),
        permissionMode: "allow_all",
      } as never,
      signal: new AbortController().signal,
      prepared: {
        threadId: "thread-1",
        runId: "run-1",
        systemPrompt: "system",
        vendorConfig: {},
        tools: [],
        runStore: {},
      } as never,
      sendBaseEvent: vi.fn(),
    });

    await expect(runtime.checkPermission("computer_use_click", {})).resolves.toBe(false);
    await expect(runtime.checkPermission("computer_use_click", { sessionId: "session-1" })).resolves.toBe(true);
    expect(leaseAllows).toHaveBeenCalledWith({
      pluginId: "computer-use",
      conversationId: "thread-1",
      runId: "run-1",
      capability: "computer-use",
      scope: { sessionId: "session-1" },
    });
    expect(checkPermission).not.toHaveBeenCalled();
  });
});
