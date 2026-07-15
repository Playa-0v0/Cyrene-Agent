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
  source: "daily_recommendation" | "search";
  query?: string;
  createdAt: number;
  expiresAt: number;
  conversationId: string;
  tracks: MusicTrack[];
}

export interface PlaybackDispatchResult {
  state: "dispatched" | "client_unavailable" | "launch_failed";
  resourceType: "song" | "playlist";
  resourceId: string;
  errorCode?: string;
}

export type MusicBackendState =
  | "stopped" | "starting" | "ready" | "degraded" | "incompatible" | "failed";
export type MusicAccountState =
  | "unknown" | "signed_out" | "validating" | "signed_in" | "expired" | "temporarily_unavailable";
export type MusicPlayerState = "unknown" | "available" | "unavailable";
export type LoginFlowState =
  | "idle" | "creating_qr" | "waiting_scan" | "waiting_confirm"
  | "authorized" | "expired" | "cancelled" | "failed";

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
