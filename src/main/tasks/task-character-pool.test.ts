import { describe, expect, it } from "vitest";
import { TaskCharacterLeasePool, buildGoldenDescendantsPrompt, getGoldenDescendantNames } from "./task-character-pool";

describe("TaskCharacterLeasePool", () => {
  it("exports one canonical Golden Descendant list for prompts and tool schemas", () => {
    expect(getGoldenDescendantNames()).toEqual(expect.arrayContaining(["风堇", "万敌"]));
    expect(buildGoldenDescendantsPrompt()).toContain("黄金裔");
    expect(buildGoldenDescendantsPrompt()).toContain("风堇");
  });
  it("leases the companion explicitly selected by the model", () => {
    const pool = new TaskCharacterLeasePool();
    const lease = pool.acquire("chat-a", "风堇");

    expect(lease).toMatchObject({ nickname: "风堇", assetFileName: "风堇.png" });
  });

  it("rejects an unknown or already busy companion in the same conversation", () => {
    const pool = new TaskCharacterLeasePool();
    pool.acquire("chat-a", "风堇");

    expect(() => pool.acquire("chat-a", "风堇")).toThrow("TASK_COMPANION_BUSY");
    expect(() => pool.acquire("chat-a", "未知角色")).toThrow("TASK_COMPANION_UNKNOWN");
  });

  it("releases an explicit lease idempotently", () => {
    const pool = new TaskCharacterLeasePool();
    const lease = pool.acquire("chat-a", "风堇");
    lease.release();
    lease.release();

    expect(pool.acquire("chat-a", "风堇").nickname).toBe("风堇");
  });
});
