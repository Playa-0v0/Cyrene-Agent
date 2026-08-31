import { describe, expect, it } from "vitest";
import { isProactiveDeliveryTargetSelectable } from "../shared/proactive-delivery";

describe("proactive delivery availability", () => {
  it("always allows local delivery", () => {
    expect(isProactiveDeliveryTargetSelectable("local", undefined)).toBe(true);
  });

  it("only allows channel delivery while the adapter is running", () => {
    expect(isProactiveDeliveryTargetSelectable("wechat", { phase: "running" })).toBe(true);
    expect(isProactiveDeliveryTargetSelectable("wechat", { phase: "offline" })).toBe(false);
    expect(isProactiveDeliveryTargetSelectable("feishu", { phase: "error" })).toBe(false);
    expect(isProactiveDeliveryTargetSelectable("feishu", undefined)).toBe(false);
  });
});
