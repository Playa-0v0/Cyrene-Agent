import { describe, expect, it, vi } from "vitest";
import { Live2DRendererLifecycleTracker } from "./lifecycle-diagnostics";

describe("Live2D renderer lifecycle diagnostics", () => {
  it("tracks listener/subscription counts and clears them on disposeAll", () => {
    const tracker = new Live2DRendererLifecycleTracker();
    const removeResize = vi.fn();
    const removeSpeech = vi.fn();

    const offResize = tracker.track("listener", "window:resize", removeResize);
    tracker.track("subscription", "live2d:onMouthStart", removeSpeech);

    expect(tracker.getDiagnostics()).toMatchObject({
      activeDisposers: 2,
      listenerCount: 1,
      subscriptionCount: 1,
      labels: ["window:resize", "live2d:onMouthStart"],
    });

    offResize();
    expect(removeResize).toHaveBeenCalledOnce();
    expect(tracker.getDiagnostics()).toMatchObject({
      activeDisposers: 1,
      listenerCount: 0,
      subscriptionCount: 1,
    });

    tracker.disposeAll();
    expect(removeSpeech).toHaveBeenCalledOnce();
    expect(tracker.getDiagnostics()).toMatchObject({
      activeDisposers: 0,
      listenerCount: 0,
      subscriptionCount: 0,
      labels: [],
    });
  });
});
