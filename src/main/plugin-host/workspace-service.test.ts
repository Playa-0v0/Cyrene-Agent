import { describe, expect, it } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createPluginWorkspaceService } from "./workspace-service";

function readerWith(bindings: Record<string, { workspaceRoot: string; displayName: string } | undefined>) {
  return {
    getWorkspaceBinding: (sessionId: string) => bindings[sessionId],
  };
}

describe("插件工作区服务", () => {
  it("已绑定的会话返回稳定投影", async () => {
    const svc = createPluginWorkspaceService({
      reader: readerWith({
        "conv-1": { workspaceRoot: "E:\\projects\\demo", displayName: "demo" },
      }),
    });
    const binding = await svc.getBinding("conv-1");
    expect(binding).toEqual({
      conversationId: "conv-1",
      root: "E:\\projects\\demo",
      displayName: "demo",
    });
  });

  it("会话不存在或未绑定返回 null", async () => {
    const svc = createPluginWorkspaceService({
      reader: readerWith({ "conv-unbound": undefined }),
    });
    expect(await svc.getBinding("conv-unbound")).toBeNull();
    expect(await svc.getBinding("conv-missing")).toBeNull();
  });

  it("非法会话 id 返回 E_INVALID_ARGUMENT", async () => {
    const svc = createPluginWorkspaceService({ reader: readerWith({}) });
    await expect(svc.getBinding("")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_INVALID_ARGUMENT",
    );
  });

  it("插件停止后返回 E_PLUGIN_STOPPING", async () => {
    const controller = new AbortController();
    const svc = createPluginWorkspaceService({
      reader: readerWith({ "conv-1": { workspaceRoot: "r", displayName: "d" } }),
      signal: controller.signal,
    });
    controller.abort();
    await expect(svc.getBinding("conv-1")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
  });
});
