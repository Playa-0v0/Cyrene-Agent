import type { MusicTrack } from "./types";

export type MusicPlaybackMode = "off" | "all" | "one" | "shuffle";

export interface PlaybackSessionInput {
  queue: MusicTrack[];
  /** -1 表示队列已建立但尚未播放；其他值必须指向 queue 中的曲目。 */
  queueIndex: number;
  playbackMode: MusicPlaybackMode;
  playlistId: string;
}

export interface PlaybackSessionTarget {
  queueIndex: number;
  track: MusicTrack;
}

export type MusicPlaybackSessionSnapshot = PlaybackSessionInput;

export class PlaybackSession {
  private input: PlaybackSessionInput | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  replace(input: PlaybackSessionInput): void {
    this.input = {
      ...input,
      queue: [...input.queue],
    };
  }

  snapshot(): MusicPlaybackSessionSnapshot | null {
    return this.input && {
      ...this.input,
      queue: [...this.input.queue],
    };
  }

  nextForEof(): PlaybackSessionTarget | null {
    if (!this.input || this.input.queue.length === 0) return null;
    if (this.input.queueIndex < 0) return null;
    if (this.input.playbackMode === "off") return null;
    if (this.input.playbackMode === "shuffle" && this.input.queue.length < 2) return null;
    const queueIndex = this.input.playbackMode === "one"
      ? this.input.queueIndex
      : this.input.playbackMode === "shuffle"
        ? this.nextShuffleIndex()
        : this.input.queueIndex >= this.input.queue.length - 1
          ? 0
          : this.input.queueIndex + 1;
    this.input.queueIndex = queueIndex;
    const track = this.input.queue[queueIndex];
    return track ? { queueIndex, track } : null;
  }

  private nextShuffleIndex(): number {
    if (!this.input || this.input.queue.length < 2) return -1;
    const index = Math.floor(this.random() * this.input.queue.length);
    return index === this.input.queueIndex ? (index + 1) % this.input.queue.length : index;
  }
}
