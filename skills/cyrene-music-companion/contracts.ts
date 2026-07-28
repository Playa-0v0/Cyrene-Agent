export interface MusicCapabilityState {
  skillEnabled: boolean;
  backendAvailable: boolean;
  enabledTools: string[];
}

export interface MusicCompanionRuntime {
  shouldInject(capabilities: MusicCapabilityState): boolean;
}
