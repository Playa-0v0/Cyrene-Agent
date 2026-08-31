// Re-export shared music state-machine types so existing main-process
// callers (`./types`) keep working while the renderer can depend on
// the shared module directly without crossing the main/renderer boundary.
export type {
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
  LoginFlowState,
} from "../../shared/music-types";

export interface EncryptedAccountBlob {
  formatVersion: 1;
  provider: "netease-cloud-music";
  savedAt: number;
  credentialRevision: number;
  payload: Buffer;
}

export interface MusicProfile {
  userId: string;
  nickname: string;
  avatarUrl?: string;
}

export interface MusicTrack {
  /** 32-hex encrypted id — the one all API calls require (play/like/playlist ops). */
  id: string;
  /** Explicit alias of `id` (OpenAPI dual-id contract; renderer Track uses this name). */
  encryptedId?: string;
  /** Numeric original id — for user-visible web links only, never for API calls. */
  originalId?: number;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  /** 仅缓存池曲目：netease = 边播边存下来的，imported = 用户本地导入的。 */
  source?: "netease" | "imported";
}

export interface MusicPlaylist {
  /** 32-hex encrypted playlist id (API ops). */
  id: string;
  originalId?: number;
  name: string;
  coverUrl?: string;
  trackCount: number;
  creator?: string;
}

export interface MusicPlaylistDetail extends MusicPlaylist {
  description?: string;
  tracks: MusicTrack[];
}

export interface MusicSubscription {
  id: string;
  name: string;
  coverUrl?: string;
}

export interface MusicSelectionSet {
  setId: string;
  provider: string;
  source: "daily_recommendation" | "search";
  query?: string;
  createdAt: number;
  expiresAt: number;
  conversationId: string;
  tracks: MusicTrack[];
}

export interface PlaybackDispatchResult {
  state: "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed";
  resourceType: "song" | "playlist";
  resourceId: string;
  errorCode?: string;
}

export class MusicInputError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "MusicInputError";
  }
}

export interface MusicShutdownReport {
  rootProcessPid?: number;
  transportClosed: boolean;
  processTreeExited: boolean;
  runtimeRemoved: boolean;
}
