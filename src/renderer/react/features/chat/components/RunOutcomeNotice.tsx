import { useTranslation } from "../../../i18n";
import "./RunExperience.css";

export type RunOutcomeKind = "direct_fallback" | "partial" | "failed";

// 只存 i18n key（非译文，可安全放模块顶层）；默认文案在组件渲染时经 t() 求值。
const DEFAULT_MESSAGE_KEYS: Record<RunOutcomeKind, string> = {
  direct_fallback: "runOutcome.directFallback",
  partial: "runOutcome.partial",
  failed: "runOutcome.failed",
};

export function RunOutcomeNotice({
  kind,
  message,
}: {
  kind: RunOutcomeKind;
  message?: string;
}) {
  const { t } = useTranslation();
  return <div className={`cy-run-outcome cy-run-outcome--${kind}`} role="status">{message ?? t(DEFAULT_MESSAGE_KEYS[kind])}</div>;
}
