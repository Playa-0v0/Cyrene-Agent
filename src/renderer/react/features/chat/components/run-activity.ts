import { t } from "../../../i18n";
import type { RunActivityRecord } from "../../../../../shared/chat-types";

export interface RunActivitySnapshot {
  processingMs: number;
  reasoningMs: number;
  processing: boolean;
}

export function resolveRunActivitySnapshot(
  activity: RunActivityRecord,
  now: number,
): RunActivitySnapshot {
  const completedAt = activity.completedAt;
  const effectiveNow = completedAt ?? now;
  return {
    processingMs: Math.max(0, effectiveNow - activity.startedAt),
    reasoningMs: Math.max(
      0,
      activity.reasoningMs + (activity.activeReasoningStartedAt
        ? effectiveNow - activity.activeReasoningStartedAt
        : 0),
    ),
    processing: completedAt === undefined,
  };
}

export function resolveRunActivityExpanded(
  expandedById: Readonly<Record<string, boolean>>,
  activityId: string,
  activity: RunActivityRecord,
): boolean {
  return expandedById[activityId] ?? (activity.completedAt === undefined || activity.keepExpanded === true);
}

export function shouldAutoCollapseRunActivity(
  wasProcessing: boolean,
  isProcessing: boolean,
  keepExpanded = false,
): boolean {
  return wasProcessing && !isProcessing && !keepExpanded;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  return minutes > 0
    ? t("runActivity.elapsedMinutes", { minutes, seconds: remainderSeconds })
    : t("runActivity.elapsedSeconds", { seconds: remainderSeconds });
}
