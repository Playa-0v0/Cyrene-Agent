import manifest from "./manifest.json";
import type { LearnTutorRuntime } from "./contracts";

export function createLearnTutorRuntime(): LearnTutorRuntime {
  return {
    shouldInject: (capabilities) => {
      if (!capabilities.skillEnabled || !capabilities.obsidianAvailable) return false;
      const enabled = new Set(capabilities.enabledTools);
      return manifest.dependencies.every((toolId) => enabled.has(toolId));
    },
  };
}

export type {
  LearnTutorCapabilityState,
  LearnTutorRuntime,
} from "./contracts";
