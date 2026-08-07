import { describe, expect, it } from "vitest";
import {
  buildDiscordMusicControls,
  buildDiscordMusicModes,
  buildDiscordMusicHistory,
  buildDiscordMusicPlaylists,
  buildDiscordMusicLibrary,
  buildDiscordSpotifyPlaylists,
  buildDiscordSpotifyArtists,
  buildDiscordHelp,
  buildDiscordMusicPlayer,
  buildDiscordMusicProgress,
  buildDiscordMusicQueue,
  buildDiscordMusicSearchResults,
  buildDiscordVolumeControl,
  DISCORD_SLASH_COMMAND_NAMES,
  DISCORD_SLASH_COMMANDS,
  musicRequestFromButton,
} from "./slash-commands";

describe("Discord slash commands", () => {
  it("registers unique command names", () => {
    expect(new Set(DISCORD_SLASH_COMMAND_NAMES).size).toBe(DISCORD_SLASH_COMMAND_NAMES.length);
  });

  it("covers chat, voice, music controls, queue editing and status", () => {
    expect(DISCORD_SLASH_COMMAND_NAMES).toEqual(expect.arrayContaining([
      "chat", "draw", "game", "join", "leave", "play", "list", "status", "help",
    ]));
  });

  it("uses short lowercase English names", () => {
    for (const name of DISCORD_SLASH_COMMAND_NAMES) expect(name).toMatch(/^[a-z]+$/);
    expect(DISCORD_SLASH_COMMAND_NAMES).toContain("play");
    expect(DISCORD_SLASH_COMMAND_NAMES).not.toContain("skip");
  });

  it("keeps every description within Discord limits", () => {
    for (const command of DISCORD_SLASH_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("builds a polished private help card with working library shortcuts", () => {
    const payload = buildDiscordHelp({ username: "昔漣寶寶", avatarUrl: "https://example.com/avatar.png" });
    const embed = payload.embeds[0].toJSON();
    expect(embed.author?.name).toContain("昔漣寶寶");
    expect(embed.title).toContain("昔漣");
    expect(embed.fields?.map((field) => field.name)).toEqual(expect.arrayContaining([
      "💬  文字聊天與發送語音 (Chat & Voice Message)",
      "⚔️  遊戲代肝與自動每日 (Game Daily Automation)",
      "🎵  音樂代播與聲優導播 (Music & DJ)",
      "🌙  生活陪伴與助眠儀式 (Living & Sleep)",
      "♟️  娛樂與遊戲對弈 (Games & Draw)",
    ]));
    expect(embed.thumbnail?.url).toBe("https://example.com/avatar.png");
  });

  it("builds a five-button public music control row", () => {
    const row = buildDiscordMusicControls().toJSON();
    expect(row.components).toHaveLength(5);
    expect(row.components.map((button) => "custom_id" in button ? button.custom_id : undefined)).toEqual([
      "cyrene:music:previous",
      "cyrene:music:toggle",
      "cyrene:music:skip",
      "cyrene:music:favorite",
      "cyrene:music:stop",
    ]);
  });

  it("uses emoji and English labels and changes the combined play button state", () => {
    const playing = buildDiscordMusicControls(false).toJSON().components[1];
    const paused = buildDiscordMusicControls(true).toJSON().components[1];
    expect("label" in playing ? playing.label : undefined).toBe("Pause");
    expect("label" in paused ? paused.label : undefined).toBe("Play");
    expect("emoji" in playing ? playing.emoji?.name : undefined).toBe("⏸️");
    expect("emoji" in paused ? paused.emoji?.name : undefined).toBe("▶️");
  });

  it("maps music buttons back to commands", () => {
    expect(musicRequestFromButton("cyrene:music:previous")).toEqual({ command: "previous" });
    expect(musicRequestFromButton("cyrene:music:toggle", false)).toEqual({ command: "pause" });
    expect(musicRequestFromButton("cyrene:music:toggle", true)).toEqual({ command: "resume" });
    expect(musicRequestFromButton("cyrene:music:skip")).toEqual({ command: "skip" });
    expect(musicRequestFromButton("cyrene:music:shuffle-toggle", false, false)).toEqual({ command: "shuffle" });
    expect(musicRequestFromButton("cyrene:music:shuffle-toggle", false, true)).toEqual({ command: "ordered" });
    expect(musicRequestFromButton("cyrene:music:repeat-cycle", false, false, "off")).toEqual({ command: "repeat-queue" });
    expect(musicRequestFromButton("cyrene:music:repeat-cycle", false, false, "queue")).toEqual({ command: "repeat-track" });
    expect(musicRequestFromButton("cyrene:music:refresh")).toEqual({ command: "refresh" });
    expect(musicRequestFromButton("unrelated")).toBeNull();
  });

  it("reflects shuffle and repeat state in the mode buttons", () => {
    const row = buildDiscordMusicModes(true, "track").toJSON();
    expect(row.components).toHaveLength(5);
    expect("label" in row.components[0] ? row.components[0].label : undefined).toBe("Shuffle");
    expect("label" in row.components[1] ? row.components[1].label : undefined).toBe("Repeat");
    expect("emoji" in row.components[1] ? row.components[1].emoji?.name : undefined).toBe("🔂");
    expect(row.components.map((button) => "custom_id" in button ? button.custom_id : undefined)).toEqual([
      "cyrene:music:shuffle-toggle",
      "cyrene:music:repeat-cycle",
      "cyrene:music:autoplay-toggle",
      "cyrene:music:source-link",
      "cyrene:music:favorites",
    ]);
  });

  it("toggles auto play from the player", () => {
    expect(musicRequestFromButton("cyrene:music:autoplay-toggle", false, false, "off", false))
      .toEqual({ command: "autoplay-on" });
    expect(musicRequestFromButton("cyrene:music:autoplay-toggle", false, false, "off", true))
      .toEqual({ command: "autoplay-off" });
  });

  it("opens private listening history from the player", () => {
    expect(musicRequestFromButton("cyrene:music:history")).toEqual({ command: "history" });
    const payload = buildDiscordMusicHistory([{
      id: "one",
      title: "勇者",
      url: "https://example.com/song",
      playlistTitle: "葬送的芙莉蓮",
      playedAt: "2026-07-22T12:00:00.000Z",
    }]);
    const embed = payload.embeds[0].toJSON();
    expect(embed.author?.name).toContain("PRIVATE HISTORY");
    expect(embed.description).toContain("[勇者](https://example.com/song)");
    expect(embed.description).toContain("🔗 `https://example.com/song`");
    expect(embed.description).toContain("葬送的芙莉蓮");
  });

  it("saves the current song and opens a private selectable favorites list", () => {
    const row = buildDiscordMusicLibrary().toJSON();
    expect(row.components.map((button) => "custom_id" in button ? button.custom_id : undefined)).toEqual([
      "cyrene:music:volume-down",
      "cyrene:music:volume-display",
      "cyrene:music:volume-up",
      "cyrene:music:queue",
      "cyrene:music:history",
    ]);
    expect("label" in row.components[0] ? row.components[0].label : undefined).toBe("−");
    expect("label" in row.components[1] ? row.components[1].label : undefined).toBe("100%");
    expect("disabled" in row.components[1] ? row.components[1].disabled : undefined).toBe(true);
    expect("label" in row.components[2] ? row.components[2].label : undefined).toBe("+");
    expect("label" in row.components[4] ? row.components[4].label : undefined).toBe("History");
    expect(musicRequestFromButton("cyrene:music:favorite")).toEqual({ command: "favorite" });
    expect(musicRequestFromButton("cyrene:music:favorites")).toEqual({ command: "favorites" });
    expect(musicRequestFromButton("cyrene:music:volume-down", false, false, "off", false, 100)).toEqual({ command: "volume", value: 75 });
    expect(musicRequestFromButton("cyrene:music:volume-up", false, false, "off", false, 100)).toEqual({ command: "volume", value: 125 });
    expect(musicRequestFromButton("cyrene:music:volume-down", false, false, "off", false, 0)).toEqual({ command: "volume", value: 0 });
    expect(musicRequestFromButton("cyrene:music:volume-up", false, false, "off", false, 150)).toEqual({ command: "volume", value: 150 });
    const playlists = [{
      id: "default",
      name: "Bili/YT favorites",
      tracks: [{
        id: "favorite-one",
        title: "勇者",
        url: "https://www.youtube.com/watch?v=song",
        playlistTitle: "葬送的芙莉蓮",
        savedAt: "2026-07-26T10:00:00.000Z",
      }],
      createdAt: "2026-07-26T10:00:00.000Z"
    }];
    const payload = buildDiscordMusicPlaylists(playlists, "default");
    expect(payload.embeds[0].toJSON().author?.name).toContain("Bili/YT favorites");
    expect(payload.components[0].toJSON().components[0]).toMatchObject({
      custom_id: "cyrene:music:favorites-select",
    });
    expect(payload.components[1].toJSON().components.map((button: any) => "custom_id" in button ? button.custom_id : undefined)).toEqual([
      "cyrene:music:playlist-back",
      "cyrene:music:playlist-play-all",
      "cyrene:music:favorites-add",
      "cyrene:music:favorites-delete",
    ]);
  });

  it("verifies that favorite is not registered", () => {
    expect(DISCORD_SLASH_COMMAND_NAMES).not.toContain("favorite");
    expect(DISCORD_SLASH_COMMAND_NAMES).not.toContain("like");
  });

  it("describes play and list as music playback commands", () => {
    const play = DISCORD_SLASH_COMMANDS.find((item) => item.name === "play");
    const list = DISCORD_SLASH_COMMANDS.find((item) => item.name === "list");
    expect(play?.description).toContain("搜尋歌曲");
    expect(play?.description).toMatch(/YouTube|Bilibili|SoundCloud|Spotify/);
    expect(list?.description).toContain("Spotify");
  });

  it("builds a private selectable Spotify playlist list", () => {
    const payload = buildDiscordSpotifyPlaylists([{
      id: "spotify-list",
      name: "My Mix",
      url: "https://open.spotify.com/playlist/spotify-list",
      total: 42,
      owner: "Cyrene",
    }]);
    const embed = payload.embeds[0].toJSON();
    expect(embed.author?.name).toContain("SPOTIFY");
    expect(embed.description).toContain("My Mix");
    expect(payload.components[0].toJSON().components[0]).toMatchObject({
      custom_id: "cyrene:music:spotify-select",
    });
  });

  it("groups saved Spotify links in a local folder without showing account playlists", () => {
    const payload = buildDiscordMusicPlaylists([
      { id: "default", name: "Bili/YT favorites", tracks: [], createdAt: "2026-01-01T00:00:00Z" },
      { id: "saved-mix", name: "JAPANESE FUNK", url: "https://open.spotify.com/playlist/funk", folder: "spotify", tracks: [], total: 47, createdAt: "2026-01-01T00:00:00Z" },
    ], undefined, [{ id: "account-only", name: "Should not appear", url: "https://open.spotify.com/playlist/account", total: 99 }]);
    const description = payload.embeds[0].toJSON().description ?? "";
    expect(description).toContain("Spotify Playlist");
    expect(description).toContain("JAPANESE FUNK");
    expect(description).not.toContain("Should not appear");
    expect(payload.components[0].toJSON().components[0]).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ value: "spotify:saved-mix" })]),
    });
  });

  it("labels a locally saved Spotify playlist as a link instead of an empty playlist", () => {
    const payload = buildDiscordSpotifyPlaylists([{
      id: "saved:local-list",
      name: "Saved Mix",
      url: "https://open.spotify.com/playlist/local-list",
      total: 0,
      savedLink: true,
    }]);
    expect(payload.embeds[0].toJSON().description).toContain("已儲存連結");
    expect(payload.components[0].toJSON().components[0]).toMatchObject({
      options: [expect.objectContaining({
        value: "saved:local-list",
        description: "已儲存的 playlist 連結",
      })],
    });
  });

  it("builds selectable Spotify artist search results", () => {
    const payload = buildDiscordSpotifyArtists("YOASOBI", [{
      id: "artist-one",
      name: "YOASOBI",
      url: "https://open.spotify.com/artist/artist-one",
      followers: 123456,
    }]);
    expect(payload.embeds[0].toJSON().description).toContain("YOASOBI");
    expect(payload.components[0].toJSON().components[0]).toMatchObject({
      custom_id: "cyrene:music:spotify-artist-select",
    });
    const listCommand = DISCORD_SLASH_COMMANDS.find((item) => item.name === "list");
    expect(listCommand?.options?.[0]).toMatchObject({ name: "name", required: false });
  });

  it("keeps long or malformed history inside Discord embed limits", () => {
    const payload = buildDiscordMusicHistory(Array.from({ length: 15 }, (_, index) => ({
      id: String(index),
      title: `歌曲 ${index} ${"很長".repeat(100)}`,
      url: `https://example.com/${"path".repeat(200)}/${index}`,
      playlistTitle: "播放清單".repeat(30),
      playedAt: index === 0 ? "not-a-date" : "2026-07-22T12:00:00.000Z",
    })));
    const description = payload.embeds[0].toJSON().description ?? "";
    expect(description.length).toBeLessThanOrEqual(3900);
    expect(description).not.toContain("NaN");
  });

  it("offers preset volume levels without typing a command", () => {
    const row = buildDiscordVolumeControl().toJSON();
    const menu = row.components[0];
    expect("options" in menu ? menu.options.map((option) => option.value) : []).toEqual([
      "0", "25", "50", "75", "100", "125", "150",
    ]);
  });

  it("builds a now-playing card with cover, progress and queue details", () => {
    const payload = buildDiscordMusicPlayer({
      active: true,
      paused: false,
      current: {
        id: "song-1",
        title: "勇者",
        url: "https://www.bilibili.com/video/example",
        thumbnail: "https://example.com/cover.jpg",
        playlistTitle: "葬送的芙莉蓮 音樂集",
        duration: 195,
        index: 1,
        total: 7,
      },
      queue: [{ title: "Anytime Anywhere", url: "https://example.com/2", index: 2, total: 7 }],
      volume: 75,
      repeat: "off",
      shuffle: false,
      autoplay: false,
      elapsed: 42,
    });
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("勇者");
    expect(embed.url).toBeUndefined();
    expect(embed.thumbnail?.url).toBe("https://example.com/cover.jpg");
    expect(embed.description).toContain("葬送的芙莉蓮 音樂集");
    expect(embed.description).toContain("00:42");
    expect(embed.footer?.text).toContain("VOL 75%");
    expect(payload.components).toHaveLength(3);
    expect(payload.components.map((row) => row.toJSON().components.length)).toEqual([5, 5, 5]);
    expect(payload.components[1].toJSON().components[1]).toMatchObject({ label: "75%", disabled: true });
    expect(payload.components[2].toJSON().components[3]).toMatchObject({ custom_id: "cyrene:music:source-link", label: "Copy" });
  });

  it("turns a disconnected player into a resumable card with one blue Play action", () => {
    const payload = buildDiscordMusicPlayer({
      active: false,
      resumable: true,
      paused: true,
      current: { title: "ADAMAS — LiSA", url: "https://open.spotify.com/track/one", duration: 225, index: 44, total: 100, playlistTitle: "anime" },
      queue: [{ title: "Sign — Uchida Aya", url: "https://example.com/next", index: 45, total: 100 }],
      volume: 100,
      repeat: "off",
      shuffle: true,
      autoplay: false,
      elapsed: 210,
    });
    const embed = payload.embeds[0].toJSON();
    const controls = payload.components[0].toJSON().components;
    expect(embed.author?.name).toContain("READY TO RESUME");
    expect(embed.description).toContain("03:30");
    expect(controls[1]).toMatchObject({ custom_id: "cyrene:music:toggle", label: "Play" });
    expect("disabled" in controls[1] ? controls[1].disabled : false).not.toBe(true);
    expect(controls.filter((button) => "disabled" in button && button.disabled === true)).toHaveLength(4);
  });

  it("builds a compact private queue card", () => {
    const payload = buildDiscordMusicQueue({
      active: true,
      paused: false,
      current: { title: "勇者", url: "https://example.com/1", index: 1, total: 2, playlistTitle: "芙莉蓮" },
      queue: [{ title: "Anytime Anywhere", url: "https://example.com/2", index: 2, total: 2, duration: 227 }],
      volume: 100,
      repeat: "off",
      shuffle: false,
      autoplay: false,
      elapsed: 10,
    });
    const embed = payload.embeds[0].toJSON();
    expect(embed.author?.name).toContain("PRIVATE QUEUE");
    expect(embed.description).toContain("Anytime Anywhere · 03:47");
    expect(embed.footer?.text).toContain("只有你看得到");
  });

  it("builds a selectable five-result music search card", () => {
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://youtube.com/watch?v=result${index}`,
      duration: 180 + index,
      index: index + 1,
      total: 5,
    }));
    const payload = buildDiscordMusicSearchResults("test song", tracks, "session-id");
    const embed = payload.embeds[0].toJSON();
    const row = payload.components[0].toJSON();
    expect(embed.author?.name).toContain("SEARCH");
    expect(embed.description).toContain("Result 1 · 3:00");
    expect(row.components[0]).toMatchObject({ custom_id: "cyrene:music:search:session-id" });
    expect("options" in row.components[0] ? row.components[0].options : []).toHaveLength(5);
  });

  it("renders a bounded Discord progress rail", () => {
    expect(buildDiscordMusicProgress(30, 120)).toMatch(/^00:30 .+ 02:00$/);
    expect(buildDiscordMusicProgress(999, 120)).toContain("02:00");
  });

  it("moves the progress marker even when a stream has no known duration", () => {
    const initial = buildDiscordMusicProgress(0);
    const later = buildDiscordMusicProgress(10);
    expect(initial).toContain("串流中");
    expect(later).toContain("串流中");
    expect(later).not.toBe(initial);
  });
});
