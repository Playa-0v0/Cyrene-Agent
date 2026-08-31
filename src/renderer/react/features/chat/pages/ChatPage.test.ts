import { describe, expect, it } from "vitest";
import { shouldListenForDeferredPlanEvents, shouldRunModelForMode } from "./conversation-run-policy";

describe("React Code conversation run policy", () => {
  it("runs the model for ordinary Code messages", () => {
    expect(shouldRunModelForMode("code", false, false)).toBe(true);
  });

  it("keeps the post-run plan listener active in both Code and Chat modes", () => {
    expect(shouldListenForDeferredPlanEvents("code")).toBe(true);
    expect(shouldListenForDeferredPlanEvents("chat")).toBe(true);
    expect(shouldListenForDeferredPlanEvents("work")).toBe(false);
    expect(shouldListenForDeferredPlanEvents("learn")).toBe(false);
  });
});
