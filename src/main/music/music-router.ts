import type { MusicProvider, MusicProviderId } from "./music-provider";

export class MusicRouter {
  constructor(
    private readonly providers: Map<MusicProviderId, MusicProvider>,
    private readonly getDefaultProviderId: () => MusicProviderId,
  ) {}

  resolve(explicitProvider?: MusicProviderId): MusicProvider {
    const id = explicitProvider ?? this.getDefaultProviderId();
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`E_MUSIC_PROVIDER_UNAVAILABLE:${id}`);
    return provider;
  }
}
