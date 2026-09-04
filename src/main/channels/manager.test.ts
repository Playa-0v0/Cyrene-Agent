import { describe, expect, it } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";

function fakeAdapter(id: string): ChannelAdapter {
  let started = false;
  return {
    id: id as never,
    displayName: id,
    capability: {} as never,
    onMessage: null,
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
    },
    send: async () => ({ ok: true }),
    getStatus: () => ({ enabled: started, phase: started ? "running" : "offline" }),
  };
}

describe("ChannelManager", () => {
  it("startOne 启动单个 adapter；unregister 先 stop 再移除", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    expect(mgr.getAdapter("qq" as never)).toBeDefined();
    expect(adapter.getStatus().phase).toBe("running");

    const removed = await mgr.unregister("qq" as never);
    expect(removed).toBe(true);
    expect(mgr.getAdapter("qq" as never)).toBeUndefined();
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("unregister 不存在的 id 返回 false", async () => {
    const mgr = new ChannelManager();
    expect(await mgr.unregister("nope" as never)).toBe(false);
  });

  it("startAll 跳过已启动的 adapter（避免渠道插件双启动）", async () => {
    const mgr = new ChannelManager();
    let startCount = 0;
    const adapter = fakeAdapter("qq");
    const origStart = adapter.start;
    adapter.start = async () => {
      startCount += 1;
      await origStart();
    };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    await mgr.startAll();
    expect(startCount).toBe(1);
  });

  it("拒绝重复 id，避免覆盖已启动 adapter 后留下错误状态", async () => {
    const mgr = new ChannelManager();
    const first = fakeAdapter("feishu");
    const second = fakeAdapter("feishu");
    mgr.register(first);
    await mgr.startOne("feishu" as never);
    expect(() => mgr.register(second)).toThrow(/禁止覆盖/);
    expect(mgr.getAdapter("feishu" as never)).toBe(first);
    expect(second.getStatus().phase).toBe("offline");
  });

  it("startOne 对已启动 adapter 幂等", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    let starts = 0;
    const original = adapter.start;
    adapter.start = async () => { starts += 1; await original(); };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    await mgr.startOne("qq" as never);
    expect(starts).toBe(1);
  });
});
