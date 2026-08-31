import { describe, expect, it, vi } from "vitest";
import { raceWithSignal } from "./abort-utils";

describe("raceWithSignal", () => {
  it("removes its listener when the source promise settles first", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(raceWithSignal(Promise.resolve("ok"), controller.signal)).resolves.toBe("ok");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects promptly with AbortError when the signal wins", async () => {
    const controller = new AbortController();
    const pending = new Promise<never>(() => {});
    const raced = raceWithSignal(pending, controller.signal);
    controller.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves a non-abort source rejection", async () => {
    const controller = new AbortController();
    await expect(raceWithSignal(Promise.reject(new Error("boom")), controller.signal))
      .rejects.toThrow("boom");
  });
});
