import manifest from "./manifest.json";
import type { MusicCompanionRuntime } from "./contracts";

export function createMusicCompanionRuntime(): MusicCompanionRuntime {
  return {
    shouldInject: (capabilities) => {
      if (!capabilities.skillEnabled || !capabilities.backendAvailable) return false;
      const enabled = new Set(capabilities.enabledTools);
      return manifest.dependencies.every((toolId) => enabled.has(toolId));
    },
  };
}

export type {
  MusicCapabilityState,
  MusicCompanionRuntime,
} from "./contracts";
