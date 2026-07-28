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
  id: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
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
  resolutionRunId?: string;
  resolutionPurpose?: "discover" | "play";
  presentedAt?: number;
  presentedTrackIds?: string[];
  tracks: MusicTrack[];
}

export interface PlaybackDispatchResult {
  state: "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed";
  resourceType: "song" | "playlist";
  resourceId: string;
  errorCode?: string;
}

export interface CandidatePlaybackRequest {
  provider: string;
  setId: string;
  trackId: string;
  conversationId: string;
  runId?: string;
}

/** Tool Runtime only. Never expose these Provider parameters to the Agent or CITA package. */
export interface MusicCandidateRefPayload {
  provider: string;
  setId: string;
  trackId: string;
  conversationId: string;
}

/** Tool Runtime only. */
export interface MusicSetRefPayload {
  provider: string;
  setId: string;
  conversationId: string;
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
