export interface LearnTutorCapabilityState {
  skillEnabled: boolean;
  obsidianAvailable: boolean;
  enabledTools: string[];
}

export interface LearnTutorRuntime {
  shouldInject: (capabilities: LearnTutorCapabilityState) => boolean;
}
