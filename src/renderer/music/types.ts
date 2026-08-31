// ============================================================
// 对接契约：UI 组件只消费这些类型，播放逻辑由 mpv 后端实现
// ============================================================

export interface LyricLine {
  timeMs: number;
  text: string;
  /** 译文（网易云 transLyric 按时间戳对齐合并；无翻译的歌没有该字段）。 */
  translation?: string;
}

export interface Track {
  encryptedId: string;
  originalId: string;
  name: string;
  artists: string[];
  album?: string;
  coverImgUrl?: string;
  durationMs?: number;
  visible: boolean;
  isFavorite?: boolean;
  lyrics?: LyricLine[];
}

export interface Playlist {
  /** 32-hex 加密 ID — API 调用用这个 */
  id: string;
  /** 数字原 ID — 仅用于展示 */
  originalId: string;
  name: string;
  coverImgUrl?: string;
  trackCount: number;
  tracks: Track[];
}

/**
 * 播放模式（shuffle 不是 repeat 的一种，故整体改名 PlaybackMode）：
 *   off = 只放一次 | all = 列表循环（播到末尾回第一首）
 *   one = 单曲循环 | shuffle = 随机
 */
export type PlaybackMode = "off" | "all" | "one" | "shuffle";

export interface PlaybackState {
  currentTrack: Track | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  isMuted: boolean;
  queue: Track[];
  queueIndex: number;
  playbackMode: PlaybackMode;
  isLoading: boolean;
  error?: string;
}

export interface PlaybackActions {
  playTrack(track: Track): void;
  togglePlayPause(): void;
  next(): void;
  prev(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  addToQueue(track: Track): void;
  removeFromQueue(index: number): void;
  loadPlaylist(playlist: Playlist): void;
  /** 在当前歌单类型的模式集合内轮换（online: off/one，cache: off/all/one/shuffle） */
  cycleMode(): void;
  toggleFavorite(track: Track): void;
}

export interface MusicPlayerProps {
  state: PlaybackState;
  actions: PlaybackActions;
  /** 用户歌单列表，顶部 chips + 侧栏下拉共用 */
  playlists: Playlist[];
  activePlaylistId: string;
  onSelectPlaylist(playlist: Playlist): void;
  /** 激活歌单类型：online 双模式，cache 四模式 + 删除/导入入口 */
  modeSet: "online" | "cache";
  /** 导入本地音乐到缓存池（仅缓存歌单显示入口） */
  onImportLocalTracks?(): void;
  /** 删除缓存曲目（仅缓存歌单的每行删除按钮） */
  onRemoveCachedTrack?(track: Track): void;
  /** 搜索：query 变化时调 onSearch，结果通过 searchResults 回传 */
  searchResults: Track[];
  isSearching: boolean;
  onSearch(query: string): void;
  className?: string;
  variant?: "full" | "mini" | "bar";
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}
