import manifest from "./manifest.json";
import type { ObsidianWorkspaceRuntime } from "./contracts";

export function createObsidianWorkspaceRuntime(): ObsidianWorkspaceRuntime {
  return {
    shouldInject: (capabilities) => {
      if (!capabilities.skillEnabled || !capabilities.obsidianAvailable) return false;
      const enabled = new Set(capabilities.enabledTools);
      return manifest.dependencies.every((toolId) => enabled.has(toolId));
    },
  };
}

export type {
  ObsidianWorkspaceCapabilityState,
  ObsidianWorkspaceRuntime,
} from "./contracts";
