import { randomUUID } from "node:crypto";

export interface CapabilityLeaseRecord {
  leaseId: string;
  pluginId: string;
  conversationId: string;
  runId: string;
  capability: string;
  scope: Record<string, string>;
  issuedAt: number;
  expiresAt: number;
}

export interface CapabilityLeaseMatch {
  pluginId: string;
  conversationId: string;
  runId: string;
  capability: string;
  scope: Record<string, string>;
}

function normalizedScope(scope: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(scope)
      .filter(([key, value]) => key.length > 0 && typeof value === "string" && value.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sameScope(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(normalizedScope(left)) === JSON.stringify(normalizedScope(right));
}

export class CapabilityLeaseStore {
  private readonly leases = new Map<string, CapabilityLeaseRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: Omit<CapabilityLeaseRecord, "leaseId" | "issuedAt" | "expiresAt"> & {
    ttlMs: number;
    signal?: AbortSignal;
  }): CapabilityLeaseRecord {
    this.pruneExpired();
    const issuedAt = this.now();
    const record: CapabilityLeaseRecord = {
      leaseId: randomUUID(),
      pluginId: input.pluginId,
      conversationId: input.conversationId,
      runId: input.runId,
      capability: input.capability,
      scope: normalizedScope(input.scope),
      issuedAt,
      expiresAt: issuedAt + input.ttlMs,
    };
    this.leases.set(record.leaseId, record);
    if (input.signal?.aborted) {
      this.revoke(record.leaseId);
    } else if (input.signal) {
      const revoke = () => this.revoke(record.leaseId);
      input.signal.addEventListener("abort", revoke, { once: true });
    }
    return { ...record, scope: { ...record.scope } };
  }

  allows(input: CapabilityLeaseMatch): boolean {
    this.pruneExpired();
    for (const lease of this.leases.values()) {
      if (
        lease.pluginId === input.pluginId
        && lease.conversationId === input.conversationId
        && lease.runId === input.runId
        && lease.capability === input.capability
        && sameScope(lease.scope, input.scope)
      ) return true;
    }
    return false;
  }

  revoke(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }

  revokeRun(runId: string): number {
    let revoked = 0;
    for (const [leaseId, lease] of this.leases) {
      if (lease.runId === runId) {
        this.leases.delete(leaseId);
        revoked++;
      }
    }
    return revoked;
  }

  revokePlugin(pluginId: string): number {
    let revoked = 0;
    for (const [leaseId, lease] of this.leases) {
      if (lease.pluginId === pluginId) {
        this.leases.delete(leaseId);
        revoked++;
      }
    }
    return revoked;
  }

  size(): number {
    this.pruneExpired();
    return this.leases.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(leaseId);
    }
  }
}

export const capabilityLeaseStore = new CapabilityLeaseStore();
