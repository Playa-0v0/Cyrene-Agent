import type { ToolExecutionOutcome } from "./types";

export interface LogicalInvocationInput {
  logicalInvocationId: string;
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

function requestFingerprint(input: LogicalInvocationInput): string {
  return JSON.stringify(stable({
    capability: input.capability,
    targetRefs: input.targetRefs,
    args: input.args,
  }));
}

export class LogicalInvocationConflictError extends Error {
  readonly code = "E_LOGICAL_INVOCATION_CONFLICT";
  readonly name = "LogicalInvocationConflictError";
}

export class ExecutionLedger {
  private readonly requestFingerprints = new Map<string, string>();
  private readonly succeeded = new Map<string, ToolExecutionOutcome>();

  async execute(
    input: LogicalInvocationInput,
    run: () => Promise<ToolExecutionOutcome>,
  ): Promise<{ outcome: ToolExecutionOutcome; cached: boolean }> {
    const key = input.logicalInvocationId;
    const fingerprint = requestFingerprint(input);
    const previousFingerprint = this.requestFingerprints.get(key);
    if (previousFingerprint && previousFingerprint !== fingerprint) {
      throw new LogicalInvocationConflictError(
        `Logical invocation ${key} was reused with different request facts`,
      );
    }
    this.requestFingerprints.set(key, fingerprint);
    const existing = this.succeeded.get(key);
    if (existing) return { outcome: existing, cached: true };
    const outcome = await run();
    // 只缓存终态成功结果：非终态成功结果（terminal=false）不得写入 ExecutionLedger。
    // 原因：非终态结果是中间状态，如果被缓存，后续相同输入会命中缓存返回中间结果，
    // 导致 Agent 认为工具已成功完成而跳过实际执行，形成无限循环。
    // terminal 未显式提供时按默认终态语义（true）处理。
    if (outcome.status === "succeeded" && outcome.terminal !== false) {
      this.succeeded.set(key, outcome);
    }
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
