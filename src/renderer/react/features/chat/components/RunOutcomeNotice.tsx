import "./RunExperience.css";

export type RunOutcomeKind = "direct_fallback" | "partial" | "failed";

const DEFAULT_MESSAGE: Record<RunOutcomeKind, string> = {
  direct_fallback: "已切换为直接执行，接下来会继续完成任务。",
  partial: "部分步骤没有完成，昔涟会在回复中说明可用结果。",
  failed: "这一轮没有顺利完成，请查看回复中的说明后再试一次。",
};

export function RunOutcomeNotice({
  kind,
  message = DEFAULT_MESSAGE[kind],
}: {
  kind: RunOutcomeKind;
  message?: string;
}) {
  return <div className={`cy-run-outcome cy-run-outcome--${kind}`} role="status">{message}</div>;
}
