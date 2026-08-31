import { describe, expect, it, vi } from "vitest";
import { createCodeGitRefreshController } from "./code-git-refresh";

describe("CodeGitRefreshController", () => {
  it("coalesces requests received while a load is in flight into one follow-up load", async () => {
    let resolveFirst!: (value: number) => void;
    const load = vi.fn(() => load.mock.calls.length === 1 ? new Promise<number>((resolve) => { resolveFirst = resolve; }) : Promise.resolve(2));
    const apply = vi.fn();
    const controller = createCodeGitRefreshController({ load, apply, failed: vi.fn(), busy: vi.fn() });

    controller.request();
    controller.request();
    controller.request();
    expect(load).toHaveBeenCalledTimes(1);
    resolveFirst(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, 1);
    expect(apply).toHaveBeenNthCalledWith(2, 2);
  });
});
