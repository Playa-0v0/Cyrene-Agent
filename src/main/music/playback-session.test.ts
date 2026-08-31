import { describe, expect, it } from "vitest";
import type { MusicTrack } from "./types";
import { PlaybackSession } from "./playback-session";

const tracks: MusicTrack[] = [
  { id: "A".repeat(32), name: "第一首", artists: [] },
  { id: "B".repeat(32), name: "第二首", artists: [] },
  { id: "C".repeat(32), name: "第三首", artists: [] },
];

describe("PlaybackSession", () => {
  it("wraps a list-loop session from its final track back to the first track", () => {
    const session = new PlaybackSession();
    session.replace({ queue: tracks, queueIndex: 2, playbackMode: "all", playlistId: "__local_cache__" });

    expect(session.nextForEof()).toMatchObject({ queueIndex: 0, track: tracks[0] });
  });

  it("replays the current track in single-loop mode", () => {
    const session = new PlaybackSession();
    session.replace({ queue: tracks, queueIndex: 1, playbackMode: "one", playlistId: "__local_cache__" });

    expect(session.nextForEof()).toMatchObject({ queueIndex: 1, track: tracks[1] });
  });

  it("chooses a different cached track in shuffle mode", () => {
    const session = new PlaybackSession(() => 0);
    session.replace({ queue: tracks, queueIndex: 1, playbackMode: "shuffle", playlistId: "__local_cache__" });

    expect(session.nextForEof()).toMatchObject({ queueIndex: 0, track: tracks[0] });
  });

  it("returns a copy of the session for a newly opened player window", () => {
    const session = new PlaybackSession();
    session.replace({ queue: tracks, queueIndex: 1, playbackMode: "all", playlistId: "__local_cache__" });

    expect(session.snapshot()).toEqual({
      queue: tracks,
      queueIndex: 1,
      playbackMode: "all",
      playlistId: "__local_cache__",
    });
  });

  it("does not corrupt a one-track shuffle session when that track ends", () => {
    const session = new PlaybackSession();
    session.replace({ queue: [tracks[0]], queueIndex: 0, playbackMode: "shuffle", playlistId: "__local_cache__" });

    expect(session.nextForEof()).toBeNull();
    expect(session.snapshot()).toMatchObject({ queueIndex: 0, queue: [tracks[0]] });
  });
});
