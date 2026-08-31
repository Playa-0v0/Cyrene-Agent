// MusicProvider implementation on top of NeteaseOpenapiClient (M1).
// Coexists with the legacy NeteaseMusicProvider; MusicService switches over in M3.
//
// Playback: resolves the real audio URL, then delegates to an injected
// dispatcher (MpvController lands in M3). Without a dispatcher the provider
// reports `client_unavailable` instead of failing the whole tool call.
import type { NeteaseOpenapiClient } from "./netease-openapi-client";
import type { MusicProvider } from "./music-provider";
import type { PlaybackDispatchResult, MusicTrack, MusicPlaylist, MusicPlaylistDetail, MusicSubscription } from "./types";
import { MusicInputError } from "./types";
import {
  normalizeSongRecords,
  normalizeSongDetail,
  normalizePlaylistRecords,
  normalizePlaylistDetail,
  normalizeSubscribedAlbums,
  normalizeAddToPlaylistResult,
  normalizeRemoveFromPlaylistResult,
  assertEncryptedId,
} from "./openapi-result-normalizer";

export type PlaybackDispatcher = (
  resource: { kind: "song"; playUrl: string; track: MusicTrack } | { kind: "playlist"; playUrl: string; tracks: MusicTrack[] },
) => Promise<PlaybackDispatchResult>;

export class NeteaseOpenapiProvider implements MusicProvider {
  readonly id = "netease-openapi";

  constructor(
    private readonly client: NeteaseOpenapiClient,
    private readonly dispatch?: PlaybackDispatcher,
  ) {}

  async getDailyRecommendations(): Promise<MusicTrack[]> {
    const recs = await this.client.getDailyRecommendations(30);
    return normalizeSongRecords(recs);
  }

  async searchTracks(keyword: string): Promise<MusicTrack[]> {
    const trimmed = keyword.trim();
    if (!trimmed) throw new MusicInputError("E_SEARCH_KEYWORD_EMPTY");
    const res = await this.client.searchSongs(trimmed, 30, 0);
    return normalizeSongRecords(res.records);
  }

  async playTrack(trackId: string): Promise<PlaybackDispatchResult> {
    assertEncryptedId(trackId);
    const detail = await this.client.getSongDetail(trackId);
    if (!detail.playUrl) {
      throw new MusicInputError("E_TRACK_NOT_PLAYABLE", `E_TRACK_NOT_PLAYABLE: ${detail.name ?? trackId}`);
    }
    if (!this.dispatch) {
      return { state: "client_unavailable", resourceType: "song", resourceId: trackId, errorCode: "E_PLAYBACK_DISPATCHER_MISSING" };
    }
    return this.dispatch({
      kind: "song",
      playUrl: detail.playUrl,
      track: normalizeSongDetail(trackId, detail),
    });
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    const songs = await this.client.getPlaylistSongs(playlistId, 30, 0);
    const tracks = normalizeSongRecords(songs);
    if (tracks.length === 0) throw new MusicInputError("E_PLAYLIST_EMPTY", `E_PLAYLIST_EMPTY: ${playlistId}`);
    if (!this.dispatch) {
      return { state: "client_unavailable", resourceType: "playlist", resourceId: playlistId, errorCode: "E_PLAYBACK_DISPATCHER_MISSING" };
    }
    // Resolve the first playable track's URL as the entry point; M3's mpv
    // integration receives the full track list for queueing.
    for (const track of tracks) {
      const detail = await this.client.getSongDetail(track.id);
      if (detail.playUrl) {
        return this.dispatch({ kind: "playlist", playUrl: detail.playUrl, tracks });
      }
    }
    throw new MusicInputError("E_PLAYLIST_NOT_PLAYABLE", `E_PLAYLIST_NOT_PLAYABLE: ${playlistId}`);
  }

  async getMyPlaylists(): Promise<MusicPlaylist[]> {
    const res = await this.client.getCreatedPlaylists(50, 0);
    return normalizePlaylistRecords(res.records);
  }

  async getPlaylistDetail(playlistId: string): Promise<MusicPlaylistDetail> {
    const [detail, songs] = await Promise.all([
      this.client.getPlaylistDetail(playlistId),
      this.client.getPlaylistSongs(playlistId, 30, 0),
    ]);
    return normalizePlaylistDetail(detail, songs);
  }

  async createPlaylist(name: string, _privacy?: boolean): Promise<MusicPlaylist> {
    const trimmed = name.trim();
    if (!trimmed) throw new MusicInputError("E_PLAYLIST_NAME_EMPTY");
    // OpenAPI create endpoint takes only playlistName (manifest) — no privacy param.
    const created = await this.client.createPlaylist(trimmed);
    const normalized = normalizePlaylistRecords([created])[0];
    if (!normalized) throw new MusicInputError("E_CREATE_PLAYLIST_INVALID_RESPONSE");
    return normalized;
  }

  async addToPlaylist(playlistId: string, trackIds: string[]): Promise<{ added: number; playlistId: string }> {
    if (trackIds.length === 0) throw new MusicInputError("E_ADD_TO_PLAYLIST_EMPTY");
    const ids = trackIds.map((id) => assertEncryptedId(id));
    const payload = await this.client.addSongsToPlaylist(playlistId, ids);
    return normalizeAddToPlaylistResult(payload, ids.length, playlistId);
  }

  async removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<{ removed: number; playlistId: string }> {
    if (trackIds.length === 0) throw new MusicInputError("E_REMOVE_FROM_PLAYLIST_EMPTY");
    const ids = trackIds.map((id) => assertEncryptedId(id));
    const payload = await this.client.removeSongsFromPlaylist(playlistId, ids);
    return normalizeRemoveFromPlaylistResult(payload, ids.length, playlistId);
  }

  async getMySubscriptions(category: "artists" | "albums"): Promise<MusicSubscription[]> {
    if (category === "artists") {
      // No artist-subscription endpoint in the OpenAPI manifest — documented gap.
      return [];
    }
    const payload = await this.client.getSubscribedAlbums(20, 0);
    return normalizeSubscribedAlbums(payload);
  }
}
