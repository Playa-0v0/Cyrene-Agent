import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../../plugins/manager";
import { createPluginPromptRegistry } from "../../plugins/prompts";
import type { PluginRuntime } from "../../plugins/context";
import { createAgentRuntime, type AgentRuntimeDeps } from "./agent-runtime";

const mocks = vi.hoisted(() => ({
  onAgentRunFinished: vi.fn(),
}));

let tmp = "";
let pluginManager: PluginManager | undefined;

vi.mock("./build-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./build-options")>();
  return { ...actual, onAgentRunFinished: mocks.onAgentRunFinished };
});

function createDeps(
  publishPluginHostEvent: AgentRuntimeDeps["publishPluginHostEvent"],
): AgentRuntimeDeps {
  return {
    runtimeStateService: {
      getState: () => ({ status: "idle", expression: 0, updatedAt: 0 }),
    },
    getStickerEmbeddingIndex: () => undefined,
    publishPluginHostEvent,
  } as unknown as AgentRuntimeDeps;
}

describe("AgentRuntime 插件宿主事件", () => {
  beforeEach(() => {
    mocks.onAgentRunFinished.mockReset();
    mocks.onAgentRunFinished.mockResolvedValue({ sticker: null });
  });

  afterEach(async () => {
    await pluginManager?.stop();
    pluginManager = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
    vi.restoreAllMocks();
  });

  it("成功收尾后仅发布轮次元数据且不等待插件监听器", async () => {
    let releaseListener!: () => void;
    const listenerPending = new Promise<void>((resolve) => { releaseListener = resolve; });
    const publishPluginHostEvent = vi.fn(() => listenerPending);
    const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

    await expect(runtime.onRunFinished(
      { reply: "回复", toolResults: [] },
      "问题",
      {
        source: "desktop",
        mode: "chat",
        conversationId: "conversation-1",
        runId: "run-1",
      },
    )).resolves.toEqual({ sticker: null });

    expect(publishPluginHostEvent).toHaveBeenCalledWith("turn:completed", {
      source: "desktop",
      mode: "chat",
      conversationId: "conversation-1",
      runId: "run-1",
    });
    releaseListener();
  });

  it.each(["timeout", "cancelled", "runtime_error"] as const)(
    "非成功终态 %s 不发布轮次完成事件",
    async (status) => {
      const publishPluginHostEvent = vi.fn(async () => {});
      const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

      await runtime.onRunFinished(
        {
          reply: "未成功结束的部分回复",
          toolResults: [],
          terminal: {
            status,
            reason: "未成功结束",
            externalEffectsMayContinue: true,
          },
        },
        "问题",
        { source: "desktop", mode: "chat", conversationId: "conversation-not-completed" },
      );

      expect(publishPluginHostEvent).not.toHaveBeenCalled();
    },
  );

  it("成功收尾后通过真实 PluginManager 和 EventBus 到达插件监听器", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-turn-event-"));
    const pluginDir = path.join(tmp, "listener");
    const marker = path.join(tmp, "received.json");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      apiVersion: 1,
      id: "listener",
      name: "listener",
      version: "1.0.0",
      description: "test listener",
      author: "test",
      entry: "index.cjs",
      defaultEnabled: true,
    }), "utf8");
    writeFileSync(path.join(pluginDir, "index.cjs"), `
      const fs = require("node:fs");
      module.exports = { register(ctx) {
        ctx.events.on("host:turn:completed", (payload) => {
          fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(payload));
        });
      } };
    `, "utf8");

    const runtime: PluginRuntime = {
      toolRegistry: { register: () => {}, unregister: () => true },
      channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} },
      registerIpc: () => {},
      unregisterIpc: () => {},
      promptRegistry: createPluginPromptRegistry(),
    };
    pluginManager = new PluginManager({
      scanRoots: [{ path: tmp, source: "builtin" }],
      storageRoot: path.join(tmp, "storage"),
      runtime,
      loadEnabledMap: () => ({}),
      saveEnabledMap: () => {},
    });
    await pluginManager.start();

    const agentRuntime = createAgentRuntime(createDeps(
      (event, payload) => pluginManager!.publishHostEvent(event, payload),
    ));
    await agentRuntime.onRunFinished(
      { reply: "真实回复", toolResults: [] },
      "真实问题",
      {
        source: "desktop",
        mode: "chat",
        conversationId: "conversation-real",
        runId: "run-real",
      },
    );

    await expect.poll(() => existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      source: "desktop",
      mode: "chat",
      conversationId: "conversation-real",
      runId: "run-real",
    });
  });

  it("宿主收尾失败时不发布成功完成事件", async () => {
    mocks.onAgentRunFinished.mockRejectedValueOnce(new Error("收尾失败"));
    const publishPluginHostEvent = vi.fn(async () => {});
    const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

    await expect(runtime.onRunFinished(
      { reply: "不会发布", toolResults: [] },
      "问题",
      { source: "desktop", mode: "chat", conversationId: "conversation-failed" },
    )).rejects.toThrow("收尾失败");
    expect(publishPluginHostEvent).not.toHaveBeenCalled();
  });

  it("插件事件发布失败不改变宿主收尾结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createAgentRuntime(createDeps(async () => {
      throw new Error("监听器失败");
    }));

    await expect(runtime.onRunFinished(
      { reply: "正常回复", toolResults: [] },
      "问题",
      { source: "desktop", mode: "chat", conversationId: "conversation-listener-failed" },
    )).resolves.toEqual({ sticker: null });
    await expect.poll(() => warn.mock.calls.length).toBe(1);
  });
});
