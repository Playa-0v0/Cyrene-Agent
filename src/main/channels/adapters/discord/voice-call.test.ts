import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DiscordVoiceCall, discordMusicVolumeGain, formatDiscordMusicActivity, parseDiscordVoiceCommand, stereo48kToMono16k } from "./voice-call";
import * as musicSource from "./music-source";

describe("Discord voice commands", () => {
  it.each(["加入通話", "進來通話！", "加入語音頻道", "陪我通話"])("parses join: %s", (text) => {
    expect(parseDiscordVoiceCommand(text)).toBe("join");
  });

  it.each(["離開通話", "掛斷", "退出語音", "結束通話。"])("parses leave: %s", (text) => {
    expect(parseDiscordVoiceCommand(text)).toBe("leave");
  });

  it("does not hijack normal conversation", () => {
    expect(parseDiscordVoiceCommand("你喜歡通話嗎")) .toBeNull();
    expect(parseDiscordVoiceCommand("加入遊戲")) .toBeNull();
  });
});

describe("Discord PCM conversion", () => {
  it("downsamples stereo 48kHz PCM to mono 16kHz", () => {
    const input = Buffer.alloc(12 * 4);
    for (let frame = 0; frame < 12; frame += 1) {
      input.writeInt16LE(3000 + frame, frame * 4);
      input.writeInt16LE(1000 + frame, frame * 4 + 2);
    }
    const output = stereo48kToMono16k(input);
    expect(output.length).toBe(4 * 2);
    expect([...Array(4)].map((_, i) => output.readInt16LE(i * 2))).toEqual([2000, 2003, 2006, 2009]);
  });

  it("ignores an incomplete trailing frame", () => {
    expect(stereo48kToMono16k(Buffer.alloc(11)).length).toBe(0);
  });
});

describe("Discord music presence", () => {
  it("uses the song portion of a Bilibili multi-part title", () => {
    expect(formatDiscordMusicActivity("【音乐集】超时空辉夜姬 p01 【剧中歌】星降る海（繁星坠海）"))
      .toBe("🎧 星降る海（繁星墜海）｜劇中歌");
  });

  it("adds the song role and work name without repeating playlist metadata", () => {
    expect(formatDiscordMusicActivity("【第一季 OP】勇者", "葬送的芙莉莲 音乐集"))
      .toBe("🎧 勇者｜第一季 OP｜葬送的芙莉蓮");
  });

  it("limits Discord activity names to 128 code points", () => {
    expect([...formatDiscordMusicActivity("歌".repeat(200))]).toHaveLength(128);
  });
});

describe("Discord perceptual music volume", () => {
  it("makes 25, 50 and 75 percent audibly distinct while preserving unity at 100", () => {
    expect(discordMusicVolumeGain(0)).toBe(0);
    expect(discordMusicVolumeGain(25)).toBeCloseTo(0.0625);
    expect(discordMusicVolumeGain(50)).toBeCloseTo(0.25);
    expect(discordMusicVolumeGain(75)).toBeCloseTo(0.5625);
    expect(discordMusicVolumeGain(100)).toBe(1);
    expect(discordMusicVolumeGain(150)).toBe(1.5);
  });

  it("uses the perceptual gain when changing an active player's volume", async () => {
    const setVolume = vi.fn();
    const voice = new DiscordVoiceCall({} as never, () => ({ enabled: true } as never), async () => null);
    const internal = voice as unknown as Record<string, unknown>;
    internal.mode = "music";
    internal.connection = {};
    internal.player = { state: { status: "playing" } };
    internal.musicResource = { volume: { setVolume } };

    expect((await voice.controlMusic("volume", 50)).ok).toBe(true);
    expect(setVolume).toHaveBeenCalledWith(0.25);
  });
});

describe("Discord desktop music state", () => {
  it("advances directly when a failed idle player cannot emit another Idle event", async () => {
    const voice = new DiscordVoiceCall({} as never, () => ({ enabled: true } as never), async () => null);
    const internal = voice as unknown as {
      mode: "music";
      player: { stop: ReturnType<typeof vi.fn> };
      advanceMusic: ReturnType<typeof vi.fn>;
      stopPlayerAndAdvance: (skipRepeat: boolean) => void;
    };
    internal.mode = "music";
    internal.player = { stop: vi.fn(() => false) };
    internal.advanceMusic = vi.fn(async () => undefined);

    internal.stopPlayerAndAdvance(true);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(internal.player.stop).toHaveBeenCalledWith(true);
    expect(internal.advanceMusic).toHaveBeenCalledWith(true);
  });

  it("toggles automatic recommendations for an active session", async () => {
    const voice = new DiscordVoiceCall({} as never, () => ({ enabled: true } as never), async () => null);
    const internal = voice as unknown as Record<string, unknown>;
    internal.mode = "music";
    internal.connection = {};
    internal.player = { state: { status: "playing" } };
    expect((await voice.controlMusic("autoplay-on")).ok).toBe(true);
    expect(voice.getMusicState().autoplay).toBe(true);
    expect((await voice.controlMusic("autoplay-off")).ok).toBe(true);
    expect(voice.getMusicState().autoplay).toBe(false);
  });

  it("reserves an active music session for the user who started it", () => {
    const voice = new DiscordVoiceCall({} as never, () => ({ enabled: true } as never), async () => null);
    expect(voice.canControlMusic("anyone")).toBe(true);
    (voice as unknown as Record<string, unknown>).musicOwnerId = "owner";
    expect(voice.canControlMusic("owner")).toBe(true);
    expect(voice.canControlMusic("someone-else")).toBe(false);
  });

  it("warms only the next queued song in the background", async () => {
    const process = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      killed: false,
      kill: vi.fn(function (this: { killed: boolean }) { this.killed = true; return true; }),
    });
    const spawn = vi.spyOn(musicSource, "spawnDiscordMusicStream").mockResolvedValue(process as never);
    const voice = new DiscordVoiceCall({} as never, () => ({ enabled: true } as never), async () => null);
    const internal = voice as unknown as {
      mode: "music";
      musicQueue: Array<{ title: string; url: string; queueOrder: number }>;
      prefetchedMusic: { queueOrder: number } | null;
      scheduleNextMusicPrefetch: () => void;
      stopPrefetchedMusic: () => void;
    };
    internal.mode = "music";
    internal.musicQueue = [
      { title: "Second", url: "https://example.com/2", queueOrder: 2 },
      { title: "Third", url: "https://example.com/3", queueOrder: 3 },
    ];

    internal.scheduleNextMusicPrefetch();
    await Promise.resolve();
    await Promise.resolve();
    internal.scheduleNextMusicPrefetch();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ title: "Second" }));
    expect(internal.prefetchedMusic?.queueOrder).toBe(2);
    internal.stopPrefetchedMusic();
    spawn.mockRestore();
  });

  it("exposes the same current track, queue and volume used by Discord", () => {
    const voice = new DiscordVoiceCall({} as never, () => ({ enabled: true } as never), async () => null);
    const internal = voice as unknown as Record<string, unknown>;
    internal.mode = "music";
    internal.connection = {};
    internal.player = { state: { status: "paused" } };
    internal.currentMusicTrack = { id: "one", title: "Song one", url: "https://example.com/1", index: 1, total: 2, duration: 120, queueOrder: 0 };
    internal.musicQueue = [{ id: "two", title: "Song two", url: "https://example.com/2", index: 2, total: 2, duration: 90, queueOrder: 1 }];
    internal.musicVolume = 75;
    internal.musicRepeat = "queue";
    internal.musicResource = { playbackDuration: 12_400 };

    expect(voice.getMusicState()).toEqual({
      active: true,
      paused: true,
      current: { id: "one", title: "Song one", url: "https://example.com/1", index: 1, total: 2, duration: 120 },
      queue: [{ id: "two", title: "Song two", url: "https://example.com/2", index: 2, total: 2, duration: 90 }],
      volume: 75,
      repeat: "queue",
      shuffle: false,
      autoplay: false,
      elapsed: 12,
    });
  });
});
