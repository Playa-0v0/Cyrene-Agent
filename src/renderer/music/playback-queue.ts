import type { PlaybackMode } from "./types";

export function getNextQueueIndex({
  queueLength,
  queueIndex,
  playbackMode,
}: {
  queueLength: number;
  queueIndex: number;
  playbackMode: PlaybackMode;
}): number {
  if (queueLength === 0) return -1;
  if (queueIndex >= queueLength - 1) return playbackMode === "all" ? 0 : -1;
  return queueIndex + 1;
}
