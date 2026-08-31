import { describe, expect, it } from "vitest";
import { getNextQueueIndex } from "./playback-queue";

describe("getNextQueueIndex", () => {
  it("wraps from the final cached track to the first track in list-loop mode", () => {
    expect(getNextQueueIndex({ queueLength: 3, queueIndex: 2, playbackMode: "all" })).toBe(0);
  });
});
