export interface ExamPaperCapabilityState {
  skillEnabled: boolean;
  obsidianAvailable: boolean;
  enabledTools: string[];
}

export interface ExamPaperRuntime {
  shouldInject: (capabilities: ExamPaperCapabilityState) => boolean;
}