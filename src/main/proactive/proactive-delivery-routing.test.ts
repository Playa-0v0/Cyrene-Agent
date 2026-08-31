import { describe, expect, it, vi } from "vitest";
import { routeProactiveDelivery } from "./proactive-delivery-routing";

describe("proactive delivery routing", () => {
  it("uses local delivery only for the local target", async () => {
    const commitLocal = vi.fn(async () => ({ kind: "committed" as const }));
    const commitChannel = vi.fn();

    expect(await routeProactiveDelivery("local", { commitLocal, commitChannel })).toEqual({ kind: "committed" });
    expect(commitLocal).toHaveBeenCalledOnce();
    expect(commitChannel).not.toHaveBeenCalled();
  });

  it.each(["wechat", "feishu"] as const)("uses only the %s channel delivery", async (target) => {
    const commitLocal = vi.fn();
    const commitChannel = vi.fn(async () => ({ kind: "committed" as const }));

    expect(await routeProactiveDelivery(target, { commitLocal, commitChannel })).toEqual({ kind: "committed" });
    expect(commitLocal).not.toHaveBeenCalled();
    expect(commitChannel).toHaveBeenCalledWith(target);
  });

  it("preserves a channel cancellation result", async () => {
    const result = await routeProactiveDelivery("wechat", {
      commitLocal: vi.fn(),
      commitChannel: vi.fn(async () => ({ kind: "cancelled" as const, reason: "channel_offline" })),
    });

    expect(result).toEqual({ kind: "cancelled", reason: "channel_offline" });
  });
});
