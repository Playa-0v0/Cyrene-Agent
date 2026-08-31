// Shared music state-machine types used by both main and renderer.
// Keep this file free of electron / node imports so it can be consumed
// from the renderer bundle without layering violations.

export type MusicBackendState =
  | "stopped" | "starting" | "ready" | "degraded" | "incompatible" | "failed";

export type MusicAccountState =
  | "unknown" | "signed_out" | "validating" | "signed_in" | "expired" | "temporarily_unavailable";

export type MusicPlayerState = "unknown" | "available" | "unavailable";

export type LoginFlowState =
  | "idle" | "creating_qr" | "waiting_scan" | "waiting_confirm"
  | "authorized" | "expired" | "cancelled" | "failed";

/**
 * Live playback state pushed from main (mpv) to renderer.
 * Populated from mpv property observations.
 */
export interface PlaybackState {
  /** mpv process alive & IPC socket connected. */
  connected: boolean;
  /** A file is loaded (not necessarily playing). */
  loaded: boolean;
  paused: boolean;
  /** Seconds; 0 when unknown. */
  position: number;
  /** Seconds; 0 when unknown. */
  duration: number;
  volume: number; // 0–100
  /**
   * Playback reached end of file (mpv `eof-reached`, needs --keep-open).
   * Ground truth for "自然播完" detection; the position>=duration-1s
   * heuristic is only a fallback.
   */
  eofReached?: boolean;
  /** Currently loaded track metadata, if any. */
  track?: {
    encryptedId: string;
    name: string;
    artists: string[];
    coverUrl?: string;
  };
}

/**
 * Commands the renderer can send to main to control mpv playback.
 * Each maps 1:1 to an IPC channel.
 */
export type PlaybackAction =
  | "play" | "pause" | "toggle-play"
  | "seek" | "set-volume"
  | "stop"
  | "next" | "prev";