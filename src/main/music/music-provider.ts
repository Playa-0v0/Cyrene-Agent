import type { PlaybackDispatchResult, MusicTrack, MusicPlaylist, MusicPlaylistDetail, MusicSubscription } from "./types";

export type MusicProviderId = string;

export interface MusicProvider {
  readonly id: MusicProviderId;
  getDailyRecommendations(): Promise<MusicTrack[]>;
  searchTracks(keyword: string): Promise<MusicTrack[]>;
  playTrack(trackId: string): Promise<PlaybackDispatchResult>;
  playPlaylist(playlistId: string): Promise<PlaybackDispatchResult>;
  getMyPlaylists(): Promise<MusicPlaylist[]>;
  getPlaylistDetail(playlistId: string): Promise<MusicPlaylistDetail>;
  createPlaylist(name: string, privacy?: boolean): Promise<MusicPlaylist>;
  addToPlaylist(playlistId: string, trackIds: string[]): Promise<{ added: number; playlistId: string }>;
  removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<{ removed: number; playlistId: string }>;
  getMySubscriptions(category: "artists" | "albums"): Promise<MusicSubscription[]>;
}
