// 播放器选源判定 —— 纯函数，便于单测，也让 App.tsx 里的条件有个明确出处。
//
// 起因是一个真实 bug：本地曲库的加载和整个播放器 UI 都被挂在
// `account === "signed_in"` 下面，于是只导入了本地音乐、没登录网易云的用户，
// 打开播放器永远看到「音乐服务未就绪，请先扫码登录网易云」——而本地播放
// 根本不需要网易云。

/** 缓存/本地虚拟歌单的固定 id。 */
export const LOCAL_CACHE_PLAYLIST_ID = "__local_cache__";

/** 播放器是否有内容可放。登录网易云和有本地曲库，任一成立即可。 */
export function canOpenPlayer(opts: {
  neteaseSignedIn: boolean;
  localTrackCount: number;
}): boolean {
  return opts.neteaseSignedIn || opts.localTrackCount > 0;
}

/**
 * 当前选中的曲目还没有真正加载进 mpv 时，点「播放」该从队列的哪一首开始。
 * 返回 null 表示不适用（当前曲目已经加载，或队列是空的）。
 *
 * 存在的原因：togglePlayPause 原本第一行就是 `if (!state.currentTrack) return;`，
 * 于是新打开的播放器点播放毫无反应——mpv 里根本没加载任何文件，
 * playbackToggle 是在给一个空播放器发「继续播放」。
 * next/prev 没这个问题，因为它们走 playTrack()，会真的 load 一首歌。
 */
export function pickPlayStartIndex(opts: {
  hasCurrentTrack: boolean;
  isCurrentTrackLoaded: boolean;
  queueLength: number;
  queueIndex: number;
}): number | null {
  if (opts.hasCurrentTrack && opts.isCurrentTrackLoaded) return null; // 正常 toggle 路径
  if (opts.queueLength === 0) return null;
  // queueIndex 可能是 -1（从没选过）或越界（歌单刚换）→ 退回第一首
  return opts.queueIndex >= 0 && opts.queueIndex < opts.queueLength ? opts.queueIndex : 0;
}

/**
 * 打开播放器时该默认选哪个歌单。
 * 返回 null 表示「不动」——用户已经选过，或者没有可自动选的。
 */
export function pickInitialPlaylist(opts: {
  currentId: string;
  localTrackCount: number;
  neteasePlaylistCount: number;
  /**
   * 网易云那边是否已经有结论（未登录，或歌单已拉回来）。
   * 必须等它有结论再决定，否则会有竞态：loadCacheTracks 走的是本地 IPC，
   * 几乎必然先于走网络的 getMyPlaylists 返回，于是已登录网易云、
   * 同时又有本地缓存的用户，默认歌单会被 __local_cache__ 抢占。
   */
  neteaseResolved: boolean;
}): string | null {
  if (opts.currentId) return null;                // 不覆盖用户的手动选择
  if (!opts.neteaseResolved) return null;         // 网易云还没有结论，先别落子
  if (opts.localTrackCount === 0) return null;    // 没有本地曲库
  if (opts.neteasePlaylistCount > 0) return null; // 有网易云歌单时沿用原有的「选首个」逻辑
  return LOCAL_CACHE_PLAYLIST_ID;
}
