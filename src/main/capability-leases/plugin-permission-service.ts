import type {
  PluginCapabilityLease,
  PluginPermissionRisk,
  PluginPermissionService,
  PluginToolContext,
} from "../../plugins/api";
import { getTimeoutSettings } from "../timeout-manager";
import { requestApproval } from "../permission";
import { capabilityLeaseStore, type CapabilityLeaseStore } from "./lease-store";

const MIN_LEASE_TTL_MS = 1_000;
const DEFAULT_LEASE_TTL_MS = 10 * 60_000;
const MAX_LEASE_TTL_MS = 30 * 60_000;
const VALID_RISKS = new Set<PluginPermissionRisk>([
  "safe", "fs-read", "fs-write", "shell", "network", "screen-read", "input-control",
]);

function boundedTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs)) return DEFAULT_LEASE_TTL_MS;
  return Math.max(MIN_LEASE_TTL_MS, Math.min(MAX_LEASE_TTL_MS, Math.trunc(ttlMs)));
}

export function createPluginPermissionService(
  pluginId: string,
  store: CapabilityLeaseStore = capabilityLeaseStore,
  approve: typeof requestApproval = requestApproval,
): PluginPermissionService {
  return {
    async requestLease(request, toolContext: PluginToolContext): Promise<PluginCapabilityLease | null> {
      if (!toolContext.conversationId || !toolContext.runId) {
        throw new Error("能力租约需要 conversationId 和 runId");
      }
      if (toolContext.signal?.aborted) {
        const error = new Error("能力租约请求已取消");
        error.name = "AbortError";
        throw error;
      }
      const capability = request.capability.trim();
      if (!capability) throw new Error("能力租约 capability 不能为空");
      if (!VALID_RISKS.has(request.risk)) throw new Error(`能力租约 risk 非法: ${request.risk}`);
      if (!request.reason.trim()) throw new Error("能力租约 reason 不能为空");
      const scope = Object.fromEntries(
        Object.entries(request.scope).map(([key, value]) => [key, String(value)]),
      );
      if (
        Object.keys(scope).length === 0
        || Object.entries(scope).some(([key, value]) => !key.trim() || !value)
      ) {
        throw new Error("能力租约 scope 必须包含非空字符串字段");
      }
      const risk: PluginPermissionRisk = request.risk;
      const ttlMs = boundedTtl(request.ttlMs);
      const allowed = await approve({
        toolId: `plugin:${pluginId}:capability-lease`,
        toolName: "插件临时能力授权",
        toolDescription: request.reason,
        args: {
          pluginId,
          capability,
          scope,
          ttlMs,
        },
        risk,
        timeoutMs: getTimeoutSettings().userChoiceTimeout,
        runId: toolContext.runId,
      });
      if (!allowed) return null;
      const lease = store.issue({
        pluginId,
        conversationId: toolContext.conversationId,
        runId: toolContext.runId,
        capability,
        scope,
        ttlMs,
        signal: toolContext.signal,
      });
      return {
        leaseId: lease.leaseId,
        capability: lease.capability,
        scope: { ...lease.scope },
        expiresAt: lease.expiresAt,
      };
    },
    revokeLease: (leaseId) => { store.revoke(leaseId); },
  };
}
