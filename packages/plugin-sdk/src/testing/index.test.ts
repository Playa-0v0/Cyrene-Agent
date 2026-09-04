import { describe, expect, it } from "vitest";
import type { PluginTool } from "../api";
import {
  assertPluginTool,
  assertValidManifest,
  createMockPluginContext,
} from "./index";

function makeTool(overrides: Partial<PluginTool> = {}): PluginTool {
  return {
    id: "mock-plugin_hello",
    name: "hello",
    description: "打招呼",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
    ...overrides,
  };
}

const validManifest = {
  apiVersion: 1,
  id: "mock-plugin",
  name: "Mock",
  version: "0.1.0",
  description: "测试插件",
  author: "tester",
  entry: "index.cjs",
};

describe("createMockPluginContext", () => {
  it("登记工具、Provider、IPC 与事件订阅供测试内省", () => {
    const ctx = createMockPluginContext({ pluginId: "mock-plugin" });
    const tool = makeTool();
    ctx.registerTool(tool);
    ctx.registerPromptProvider({ id: "status", provide: () => "ok" });
    ctx.registerIpc("ping", () => "pong");
    const off = ctx.events.on("host:turn:finished", () => undefined);
    ctx.events.emit("greeting", { text: "hi" });

    expect(ctx.tools).toHaveLength(1);
    expect(ctx.promptProviders[0]?.id).toBe("status");
    expect(ctx.ipcChannels.get("ping")?.()).toBe("pong");
    expect(ctx.subscriptions.map((s) => s.event)).toEqual(["host:turn:finished"]);
    expect(ctx.emittedEvents).toEqual([{ event: "greeting", payload: { text: "hi" } }]);

    off();
    expect(ctx.subscriptions).toHaveLength(0);
  });

  it("storage 提供内存读写并返回模拟根目录", () => {
    const ctx = createMockPluginContext();
    ctx.storage.set("count", 3);
    expect(ctx.storage.get<number>("count")).toBe(3);
    expect(ctx.storage.get<string>("missing")).toBeUndefined();
    expect(ctx.storage.rootDir()).toBe("/mock/plugin-data");
  });

  it("unregister 系列拒绝未登记资源", () => {
    const ctx = createMockPluginContext();
    expect(() => ctx.unregisterTool("mock-plugin_missing")).toThrow();
    expect(() => ctx.unregisterPromptProvider("missing")).toThrow();
    expect(() => ctx.unregisterIpc("missing")).toThrow();
  });

  it("dispose 触发 signal 并按逆序执行清理回调", async () => {
    const ctx = createMockPluginContext();
    const order: string[] = [];
    ctx.onDispose(() => { order.push("first"); });
    ctx.onDispose(() => { order.push("second"); });
    await ctx.dispose();
    expect(order).toEqual(["second", "first"]);
    expect(ctx.signal.aborted).toBe(true);
    expect(() => ctx.registerTool(makeTool())).toThrow("插件停止后");
  });

  it("dispose 幂等；单个清理失败仍执行其余并最终抛错", async () => {
    const ctx = createMockPluginContext();
    const order: string[] = [];
    ctx.onDispose(() => { order.push("a"); });
    ctx.onDispose(() => { order.push("boom"); throw new Error("boom"); });
    ctx.onDispose(() => { order.push("c"); });
    await expect(ctx.dispose()).rejects.toThrow("清理回调抛出 1 个错误");
    await expect(ctx.dispose()).resolves.toBeUndefined();
    expect(order).toEqual(["c", "boom", "a"]);
  });

  it("deps 按传入内容注入", () => {
    const ctx = createMockPluginContext({
      deps: { secrets: { get: async () => "k", set: async () => undefined, delete: async () => true } },
    });
    expect(ctx.deps.secrets).toBeDefined();
    expect(ctx.deps.llm).toBeUndefined();
  });
});

describe("assertPluginTool", () => {
  it("合法工具通过", () => {
    expect(() => assertPluginTool(makeTool(), "mock-plugin")).not.toThrow();
  });

  it("汇总全部契约违规一次性抛出", () => {
    expect(() => assertPluginTool(makeTool({
      id: "wrong-prefix",
      name: "",
      description: "",
      inputSchema: { type: "string" as never, properties: {} },
      execute: undefined as never,
    }), "mock-plugin")).toThrow(/开头.*name.*description.*inputSchema.*execute/s);
  });
});

describe("assertValidManifest", () => {
  it("合法 manifest 通过；缺失必填字段抛错", () => {
    expect(() => assertValidManifest(validManifest)).not.toThrow();
    expect(() => assertValidManifest({ ...validManifest, entry: undefined })).toThrow();
    expect(() => assertValidManifest({ ...validManifest, deps: ["no-such-capability"] })).toThrow();
  });
});


