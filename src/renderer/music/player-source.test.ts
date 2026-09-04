import { describe, expect, it } from "vitest";
import { canOpenPlayer, pickInitialPlaylist, pickPlayStartIndex, LOCAL_CACHE_PLAYLIST_ID } from "./player-source";

describe("canOpenPlayer", () => {
  it("只登录了网易云 → 可以打开", () => {
    expect(canOpenPlayer({ neteaseSignedIn: true, localTrackCount: 0 })).toBe(true);
  });

  it("只有本地音乐、没登录网易云 → 也必须可以打开（这就是那个 bug）", () => {
    expect(canOpenPlayer({ neteaseSignedIn: false, localTrackCount: 12 })).toBe(true);
  });

  it("两者都有 → 可以打开", () => {
    expect(canOpenPlayer({ neteaseSignedIn: true, localTrackCount: 12 })).toBe(true);
  });

  it("两者都没有 → 才显示未就绪", () => {
    expect(canOpenPlayer({ neteaseSignedIn: false, localTrackCount: 0 })).toBe(false);
  });
});

describe("pickInitialPlaylist", () => {
  it("没登录网易云但有本地曲库 → 自动落到本地歌单", () => {
    expect(pickInitialPlaylist({ currentId: "", localTrackCount: 5, neteasePlaylistCount: 0, neteaseResolved: true }))
      .toBe(LOCAL_CACHE_PLAYLIST_ID);
  });

  it("用户已经选过歌单 → 不覆盖", () => {
    expect(pickInitialPlaylist({ currentId: "已选", localTrackCount: 5, neteasePlaylistCount: 0, neteaseResolved: true }))
      .toBeNull();
  });

  it("有网易云歌单时不抢选择权（沿用原有的选首个歌单逻辑）", () => {
    expect(pickInitialPlaylist({ currentId: "", localTrackCount: 5, neteasePlaylistCount: 3, neteaseResolved: true }))
      .toBeNull();
  });

  it("本地曲库为空 → 没什么可自动选", () => {
    expect(pickInitialPlaylist({ currentId: "", localTrackCount: 0, neteasePlaylistCount: 0, neteaseResolved: true }))
      .toBeNull();
  });
});

describe("pickPlayStartIndex", () => {
  it("刚打开播放器（无 currentTrack）→ 从队列第一首开始，而不是什么都不做", () => {
    // 这就是「能打开播放器但点播放没反应」的那个 bug
    expect(pickPlayStartIndex({
      hasCurrentTrack: false,
      isCurrentTrackLoaded: false,
      queueLength: 8,
      queueIndex: -1,
    })).toBe(0);
  });

  it("已有当前曲目 → 交给正常的 toggle 路径", () => {
    expect(pickPlayStartIndex({
      hasCurrentTrack: true,
      isCurrentTrackLoaded: true,
      queueLength: 8,
      queueIndex: 3,
    })).toBeNull();
  });

  it("只是预选了当前曲目但 mpv 尚未加载 → 真正加载所选曲目", () => {
    expect(pickPlayStartIndex({
      hasCurrentTrack: true,
      isCurrentTrackLoaded: false,
      queueLength: 8,
      queueIndex: 3,
    })).toBe(3);
  });

  it("队列为空 → 没什么可放", () => {
    expect(pickPlayStartIndex({
      hasCurrentTrack: false,
      isCurrentTrackLoaded: false,
      queueLength: 0,
      queueIndex: -1,
    })).toBeNull();
  });

  it("已选中某一首但还没播 → 从那一首开始", () => {
    expect(pickPlayStartIndex({
      hasCurrentTrack: false,
      isCurrentTrackLoaded: false,
      queueLength: 8,
      queueIndex: 5,
    })).toBe(5);
  });

  it("queueIndex 越界（刚换歌单）→ 退回第一首而不是崩", () => {
    expect(pickPlayStartIndex({
      hasCurrentTrack: false,
      isCurrentTrackLoaded: false,
      queueLength: 3,
      queueIndex: 99,
    })).toBe(0);
  });
});

describe("pickInitialPlaylist 的竞态保护", () => {
  it("网易云还没有结论时不落子（本地 IPC 比网络快，否则会抢占默认歌单）", () => {
    expect(pickInitialPlaylist({
      currentId: "", localTrackCount: 20, neteasePlaylistCount: 0, neteaseResolved: false,
    })).toBeNull();
  });

  it("结论出来后（未登录、无歌单）才落到本地歌单", () => {
    expect(pickInitialPlaylist({
      currentId: "", localTrackCount: 20, neteasePlaylistCount: 0, neteaseResolved: true,
    })).toBe(LOCAL_CACHE_PLAYLIST_ID);
  });

  it("已登录且有歌单时，即便本地曲库更早返回也不抢", () => {
    expect(pickInitialPlaylist({
      currentId: "", localTrackCount: 20, neteasePlaylistCount: 5, neteaseResolved: true,
    })).toBeNull();
  });
});
