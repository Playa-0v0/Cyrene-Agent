import { describeRunStage, type AgentRunStage } from "./run-presentation";
import "./RunExperience.css";

export function RunStageIndicator({ stage }: { stage: AgentRunStage }) {
  return (
    <span className={`cy-run-stage cy-run-stage--${stage.kind}`} role="status" aria-live="polite">
      <span className="cy-run-stage__pulse" aria-hidden="true" />
      <span>{describeRunStage(stage)}</span>
    </span>
  );
}
