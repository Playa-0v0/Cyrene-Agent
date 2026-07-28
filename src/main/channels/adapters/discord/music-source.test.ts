import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachDiscordMusicBuffer,
  findDiscordMusicUrl,
  buildSpotifySearchQuery,
  formatMusicDuration,
  cleanDiscordMusicTrackTitle,
  cleanDiscordMusicPlaylistTitle,
  normalizeYtDlpResult,
  normalizeBilibiliPages,
  parseDiscordMusicRequest,
  parseBilibiliSeasonHtml,
  parseSpotifyEmbedHtml,
  selectBilibiliTracks,
  bilibiliCookieArgs,
  configureBilibiliBrowserCookies,
  discordMusicSeekArgs,
  discordMusicStreamArgs,
  copyableDiscordMusicUrl,
} from "./music-source";

afterEach(() => configureBilibiliBrowserCookies(false));

describe("Discord music request parsing", () => {
  it("holds a startup cushion before handing audio to Discord", async () => {
    const stdout = new PassThrough();
    const process = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin: null,
      stdio: [null, stdout, new PassThrough()],
      exitCode: null,
      killed: false,
      kill: () => true,
    });
    const buffered = attachDiscordMusicBuffer(process as never);
    const ready = buffered.waitForBuffer!();
    stdout.write(Buffer.alloc(384 * 1024));

    await expect(ready).resolves.toBeGreaterThanOrEqual(384 * 1024);
    expect((buffered.audio as PassThrough).readableLength).toBeGreaterThanOrEqual(384 * 1024);
    buffered.audio?.destroy();
    stdout.destroy();
  });

  it("retries transient downloads and keeps stdout streaming for buffered playback", () => {
    expect(discordMusicStreamArgs("ytsearch1:Song Artist")).toEqual([
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--retries", "5",
      "--fragment-retries", "5",
      "--retry-sleep", "1",
      "--socket-timeout", "20",
      "--format", "bestaudio/best",
      "--output", "-",
      "ytsearch1:Song Artist",
    ]);
  });

  it("builds an accurate yt-dlp section for resuming a disconnected song", () => {
    expect(discordMusicSeekArgs(210)).toEqual([
      "--download-sections",
      "*00:03:30-inf",
      "--force-keyframes-at-cuts",
    ]);
    expect(discordMusicSeekArgs(0)).toEqual([]);
  });

  it("returns a title-free copyable Bilibili URL and keeps only the selected part", () => {
    expect(copyableDiscordMusicUrl("【影片名稱】 https://www.bilibili.com/video/BV1ABC123/?p=5&spm_id_from=333.1"))
      .toBe("https://www.bilibili.com/video/BV1ABC123?p=5");
    expect(copyableDiscordMusicUrl("https://b23.tv/abc123?share_source=copy_web"))
      .toBe("https://b23.tv/abc123");
  });
  it("only applies Opera GX cookies to Bilibili sources", () => {
    configureBilibiliBrowserCookies(true);
    expect(bilibiliCookieArgs("https://www.bilibili.com/video/BVTEST")).toEqual([
      "--cookies-from-browser",
      expect.stringContaining("opera:"),
    ]);
    expect(bilibiliCookieArgs("https://b23.tv/example")).toHaveLength(2);
    expect(bilibiliCookieArgs("https://www.youtube.com/watch?v=abcdefghijk")).toEqual([]);
    expect(bilibiliCookieArgs("https://open.spotify.com/track/example")).toEqual([]);
  });

  it.each([
    "https://youtu.be/abcdefghijk",
    "https://www.youtube.com/watch?v=abcdefghijk&list=PL123",
    "https://www.bilibili.com/video/BV1234567890?p=5",
    "https://b23.tv/abc123",
    "https://soundcloud.com/example/song",
    "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
  ])("accepts a supported music URL: %s", (url) => {
    expect(findDiscordMusicUrl(`幫我播放 ${url}`)).toBe(url);
  });

  it("does not intercept unrelated links", () => {
    expect(findDiscordMusicUrl("看看 https://example.com/video")).toBeUndefined();
  });

  it("combines Spotify title and artist for an equivalent playable search", () => {
    expect(buildSpotifySearchQuery("Never Gonna Give You Up", "Rick Astley · Whenever You Need Somebody · Song · 1987"))
      .toBe("Never Gonna Give You Up Rick Astley");
  });

  it("turns a Spotify playlist embed into attributed playable queue entries", () => {
    const data = {
      props: { pageProps: { state: { data: { entity: {
        type: "playlist",
        title: "My Mix",
        coverArt: { sources: [{ url: "https://i.scdn.co/image/cover" }] },
        trackList: [
          { uri: "spotify:track:ONE", title: "First Song", subtitle: "First Artist", duration: 183000 },
          { uri: "spotify:track:TWO", title: "第二首歌", subtitle: "歌手", duration: 204500 },
        ],
      } } } } },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    const tracks = parseSpotifyEmbedHtml(html, "https://open.spotify.com/playlist/MYMIX");
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      title: "First Song — First Artist",
      url: "https://open.spotify.com/track/ONE",
      playbackUrl: "ytsearch1:First Song First Artist",
      playlistTitle: "My Mix",
      playlistUrl: "https://open.spotify.com/playlist/MYMIX",
      duration: 183,
      index: 1,
      total: 2,
    });
    expect(tracks[1].duration).toBe(205);
  });

  it.each([
    ["暫停播放", "pause"],
    ["繼續播放！", "resume"],
    ["下一首", "skip"],
    ["停止音樂", "stop"],
    ["播放清單", "queue"],
    ["單曲循環", "repeat-track"],
    ["列表循環", "repeat-queue"],
    ["隨機播放", "shuffle"],
    ["順序播放", "ordered"],
    ["清空歌單", "clear"],
  ] as const)("parses %s", (text, command) => {
    expect(parseDiscordMusicRequest(text)).toEqual({ command });
  });

  it("parses queue editing and volume values", () => {
    expect(parseDiscordMusicRequest("移除第3首")).toEqual({ command: "remove", value: 3 });
    expect(parseDiscordMusicRequest("音量75")).toEqual({ command: "volume", value: 75 });
  });
});

describe("yt-dlp playlist normalization", () => {
  it("uses the real Bilibili part names for a large multi-part video", () => {
    const tracks = normalizeBilibiliPages({
      code: 0,
      data: {
        bvid: "BVTEST",
        title: "超級神仙の日語歌曲｜那些似曾相識的日語歌 無損音質 分集播放",
        pic: "http://img.example/cover.jpg",
        pages: [
          { page: 1, part: "001. Cry For Me (feat. Ami) - Michita", duration: 220 },
          { page: 2, part: "002. The Second Song", duration: 180, first_frame: "http://img.example/2.jpg" },
        ],
      },
    }, "https://www.bilibili.com/video/BVTEST?p=1");

    expect(tracks.map((track) => track.title)).toEqual([
      "001. Cry For Me (feat. Ami) - Michita",
      "002. The Second Song",
    ]);
    expect(tracks[0]).toMatchObject({ index: 1, total: 2, duration: 220 });
    expect(tracks[0].thumbnail).toBe("https://img.example/cover.jpg");
    expect(tracks[1].thumbnail).toBe("https://img.example/2.jpg");
  });

  it("does not let a partial Bilibili season truncate the complete page queue", () => {
    const pages = Array.from({ length: 100 }, (_, index) => ({
      id: `BVTEST-p${index + 1}`,
      title: `第 ${index + 1} 首`,
      url: `https://www.bilibili.com/video/BVTEST/?p=${index + 1}`,
      playlistTitle: "完整歌單",
      index: index + 1,
      total: 100,
    }));
    const season = pages.slice(0, 15).map((track) => ({
      ...track,
      playlistTitle: "第一個音樂集",
      total: 15,
    }));

    const tracks = selectBilibiliTracks(season, pages);

    expect(tracks).toHaveLength(100);
    expect(tracks[0].playlistTitle).toBe("第一個音樂集");
    expect(tracks[14].playlistTitle).toBe("第一個音樂集");
    expect(tracks[15].playlistTitle).toBe("完整歌單");
    expect(tracks.at(-1)).toMatchObject({ title: "第 100 首", index: 100, total: 100 });
  });

  it("expands a Bilibili UGC season into next-able videos", () => {
    const state = {
      videoData: {
        ugc_season: {
          title: "串烧推荐",
          cover: "https://img.example/season.jpg",
          sections: [{ episodes: [
            { title: "“第一首串烧”", bvid: "BVFIRST", arc: { duration: 100, pic: "http://img.example/1.jpg" } },
            { title: "“第二首串烧”", bvid: "BVSECOND", arc: { duration: 120, pic: "http://img.example/2.jpg" } },
            { title: "“第三首串烧”", bvid: "BVTHIRD", arc: { duration: 140, pic: "http://img.example/3.jpg" } },
          ] }],
        },
      },
    };
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};(function(){})</script>`;
    const tracks = parseBilibiliSeasonHtml(html, "https://www.bilibili.com/video/BVSECOND/");
    expect(tracks.map((track) => track.title)).toEqual(["第二首串燒", "第三首串燒"]);
    expect(tracks[0]).toMatchObject({ playlistTitle: "串燒推薦", index: 2, total: 3, duration: 120 });
    expect(tracks[0].thumbnail).toBe("https://img.example/2.jpg");
  });

  it("removes source and quality metadata from a playlist title", () => {
    expect(cleanDiscordMusicPlaylistTitle("【音乐集】 葬送的芙莉莲 歌曲全收录 【Hi-Res/完整版/中日歌词】"))
      .toBe("葬送的芙莉蓮 歌曲全收錄");
  });

  it("separates a repeated Bilibili playlist prefix from each song title", () => {
    const playlist = "【音乐集】葬送的芙莉莲 歌曲全收录【Hi-Res/完整版/中日歌词】";
    expect(cleanDiscordMusicTrackTitle(`${playlist} p02 【第一季 ED】 Anytime Anywhere`, playlist))
      .toBe("【第一季 ED】 Anytime Anywhere");
  });

  it("converts Simplified Chinese metadata without changing URLs", () => {
    const [track] = normalizeYtDlpResult({
      title: "串烧推荐",
      entries: [{ title: "戴上耳机，感受顶级串烧", webpage_url: "https://www.bilibili.com/video/BVTEST" }],
    }, "https://www.bilibili.com/video/BVTEST");
    expect(track.title).toBe("戴上耳機，感受頂級串燒");
    expect(track.url).toBe("https://www.bilibili.com/video/BVTEST");
  });

  it("continues a Bilibili multi-part video from the requested part", () => {
    const tracks = normalizeYtDlpResult({
      playlist_count: 6,
      entries: Array.from({ length: 6 }, (_, index) => ({
        id: `part-${index + 1}`,
        title: `第 ${index + 1} 首`,
        webpage_url: `https://www.bilibili.com/video/BVTEST?p=${index + 1}`,
        duration: 60 + index,
      })),
    }, "https://www.bilibili.com/video/BVTEST?p=5");

    expect(tracks.map((track) => track.title)).toEqual(["第 5 首", "第 6 首"]);
    expect(tracks[0]).toMatchObject({ index: 5, total: 6, duration: 64 });
  });

  it("does not truncate a large cross-category collection at 100 tracks", () => {
    const tracks = normalizeYtDlpResult({
      playlist_count: 120,
      entries: Array.from({ length: 120 }, (_, index) => ({
        id: `track-${index + 1}`,
        title: `第 ${index + 1} 首`,
        webpage_url: `https://www.bilibili.com/video/BVTEST?p=${index + 1}`,
      })),
    }, "https://www.bilibili.com/video/BVTEST");
    expect(tracks).toHaveLength(120);
    expect(tracks.at(-1)).toMatchObject({ title: "第 120 首", index: 120, total: 120 });
  });

  it("formats durations for queue messages", () => {
    expect(formatMusicDuration(125)).toBe("2:05");
    expect(formatMusicDuration(undefined)).toBe("");
  });

  it("uses the playlist title when a flat entry has no title", () => {
    const tracks = normalizeYtDlpResult({
      title: "超時空輝夜姬歌曲全收錄",
      playlist_count: 2,
      entries: [
        { url: "https://www.bilibili.com/video/BVTEST?p=1" },
        { url: "https://www.bilibili.com/video/BVTEST?p=2" },
      ],
    }, "https://www.bilibili.com/video/BVTEST");
    expect(tracks.map((track) => track.title)).toEqual(["第 1 首", "第 2 首"]);
    expect(tracks[0].playlistTitle).toBe("超時空輝夜姬歌曲全收錄");
  });

  it("keeps the best available video thumbnail for the desktop player", () => {
    const [track] = normalizeYtDlpResult({
      title: "封面測試",
      thumbnails: [{ url: "https://img.example/small.jpg" }, { url: "https://img.example/large.jpg" }],
    }, "https://youtu.be/abcdefghijk");
    expect(track.thumbnail).toBe("https://img.example/large.jpg");
  });
});
