import type { MusicMcpClient } from "./music-mcp-client";
import { normalizeDailyRecommendations, normalizeSearchResults } from "./result-normalizer";
import { normalizeMcpPlaybackResult } from "./playback-result-normalizer";
import type { MusicProvider } from "./music-provider";

export const NETEASE_PROVIDER_ID = "netease-cloud-music";

export class NeteaseMusicProvider implements MusicProvider {
  readonly id = NETEASE_PROVIDER_ID;

  constructor(private readonly client: MusicMcpClient) {}

  async getDailyRecommendations() {
    const raw = await this.client.callDataTool("cloud_music_get_daily_recommend", {});
    return normalizeDailyRecommendations(raw);
  }

  async searchTracks(keyword: string) {
    const raw = await this.client.callDataTool("cloud_music_search", { keyword, category: "song" });
    return normalizeSearchResults(raw);
  }

  async playTrack(trackId: string) {
    const raw = await this.client.callDataTool("cloud_music_play", { id: trackId, type: "song" });
    return normalizeMcpPlaybackResult(raw, "song", trackId);
  }

  async playPlaylist(playlistId: string) {
    const raw = await this.client.callDataTool("cloud_music_play", { id: playlistId, type: "playlist" });
    return normalizeMcpPlaybackResult(raw, "playlist", playlistId);
  }
}
