export interface ObsidianWorkspaceCapabilityState {
  skillEnabled: boolean;
  obsidianAvailable: boolean;
  enabledTools: string[];
}

export interface ObsidianWorkspaceRuntime {
  shouldInject: (capabilities: ObsidianWorkspaceCapabilityState) => boolean;
}
