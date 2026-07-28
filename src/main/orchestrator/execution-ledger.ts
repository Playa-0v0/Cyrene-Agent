import type { ToolExecutionOutcome } from "./types";

export interface ExecutionFingerprintInput {
  capability: string;
  targetRefs: string[];
  args: Record<string, unknown>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function fingerprint(input: ExecutionFingerprintInput): string {
  return JSON.stringify(stable(input));
}

export class ExecutionLedger {
  private readonly succeeded = new Map<string, ToolExecutionOutcome>();

  async execute(
    input: ExecutionFingerprintInput,
    run: () => Promise<ToolExecutionOutcome>,
  ): Promise<{ outcome: ToolExecutionOutcome; cached: boolean }> {
    const key = fingerprint(input);
    const existing = this.succeeded.get(key);
    if (existing) return { outcome: existing, cached: true };
    const outcome = await run();
    if (outcome.status === "succeeded") this.succeeded.set(key, outcome);
    return { outcome, cached: false };
  }
}

interface ScopedLedger {
  ledger: ExecutionLedger;
  lastUsedAt: number;
}

/** Bounded, short-lived ledger cache used to survive a retry of the same conversation turn. */
export class ExecutionLedgerStore {
  private readonly entries = new Map<string, ScopedLedger>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxScopes = 256,
    private readonly now: () => number = Date.now,
  ) {}

  forScope(scopeId: string): ExecutionLedger {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.ttlMs) this.entries.delete(id);
    }
    const existing = this.entries.get(scopeId);
    if (existing) {
      existing.lastUsedAt = now;
      return existing.ledger;
    }
    if (this.entries.size >= this.maxScopes) {
      const oldest = [...this.entries.entries()].sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    const ledger = new ExecutionLedger();
    this.entries.set(scopeId, { ledger, lastUsedAt: now });
    return ledger;
  }
}
