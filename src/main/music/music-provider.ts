import type { PlaybackDispatchResult, MusicTrack } from "./types";

export type MusicProviderId = string;

export interface MusicProvider {
  readonly id: MusicProviderId;
  getDailyRecommendations(): Promise<MusicTrack[]>;
  searchTracks(keyword: string): Promise<MusicTrack[]>;
  playTrack(trackId: string): Promise<PlaybackDispatchResult>;
  playPlaylist(playlistId: string): Promise<PlaybackDispatchResult>;
}
