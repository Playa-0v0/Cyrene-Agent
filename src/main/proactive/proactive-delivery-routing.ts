import type { ProactiveDeliveryTarget } from "../../shared/preferences";
import type { ProactiveMobileChannel } from "../channels/proactive-delivery";
import type { ProactiveCommitResult } from "./proactive-service";

interface ProactiveDeliveryRoutingDeps {
  commitLocal: () => Promise<ProactiveCommitResult>;
  commitChannel: (channel: ProactiveMobileChannel) => Promise<ProactiveCommitResult>;
}

export function routeProactiveDelivery(
  target: ProactiveDeliveryTarget,
  deps: ProactiveDeliveryRoutingDeps,
): Promise<ProactiveCommitResult> {
  return target === "local" ? deps.commitLocal() : deps.commitChannel(target);
}
