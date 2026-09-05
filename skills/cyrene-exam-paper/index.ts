import manifest from "./manifest.json";
import type { ExamPaperRuntime } from "./contracts";

export function createExamPaperRuntime(): ExamPaperRuntime {
  return {
    shouldInject: (capabilities) => {
      if (!capabilities.skillEnabled || !capabilities.obsidianAvailable) return false;
      const enabled = new Set(capabilities.enabledTools);
      return manifest.dependencies.every((toolId) => enabled.has(toolId));
    },
  };
}

export type {
  ExamPaperCapabilityState,
  ExamPaperRuntime,
} from "./contracts";