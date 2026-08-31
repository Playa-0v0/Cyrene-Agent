import type { ProactiveDeliveryTarget } from "./preferences";

export interface ProactiveChannelStatusLike {
  phase?: string;
}

export function isProactiveDeliveryTargetSelectable(
  target: ProactiveDeliveryTarget,
  status?: ProactiveChannelStatusLike,
): boolean {
  return target === "local" || status?.phase === "running";
}
