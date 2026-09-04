import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import type { LifecyclePublisher } from "./lifecycle-publisher";

/** 桌面轮次开始时已知的全部标识信息。 */
export interface PendingTurnInput {
  runId: string;
  conversationId: string;
  mode: PluginPromptMode;
  /** 已落盘的用户消息 ID；桌面轮次事件的必填边界。 */
  inputMessageId: string;
  /** 助手占位消息 ID；只有收到对应落盘确认后才作为 finalMessageId 发布。 */
  assistantMessageId?: string;
  startedAt: number;
  /** 本轮运行超时（毫秒）；整体期限 = startedAt + runTimeoutMs + graceMs。 */
  runTimeoutMs?: number;
}

export interface PendingTurnTerminal {
  status: PluginTurnStatus;
  durationMs?: number;
}

export interface PendingTurnPersistenceAck {
  /** 落盘确认对应的助手消息 ID；缺失表示只确认了本轮终态快照。 */
  finalMessageId?: string;
}

export interface PendingTurnLifecycleDeps {
  publisher: LifecyclePublisher;
  /** 时钟源（epoch 毫秒）；默认 Date.now，可注入以便测试。 */
  now?: () => number;
  /** 终态到达后等待落盘确认的上限，默认 60 秒。 */
  ackTimeoutMs?: number;
  /** 整体期限在运行超时之外的宽限量，默认 60 秒。 */
  graceMs?: number;
  /** 条目被放弃（best-effort at-most-once）时的诊断回调。 */
  onAbandon?: (runId: string, reason: string) => void;
}

interface PendingTurnEntry {
  input: PendingTurnInput;
  createdAt: number;
  /** 整体期限：超过即清理，不论是否到达终态。 */
  expiresAt: number;
  terminal?: PendingTurnTerminal;
  persistenceAck?: PendingTurnPersistenceAck;
  published: boolean;
  overallTimer: ReturnType<typeof setTimeout>;
  ackTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 桌面轮次生命周期协调器：
 * turn:started 在 run 开始时立即发布；turn:finished 必须同时拿到
 * 主进程终态与渲染端落盘确认才发布一次（best-effort at-most-once）。
 * 落盘确认迟迟不到（60 秒）或整体期限到期时放弃发布，绝不伪造消息边界。
 */
export function createPendingTurnLifecycle(deps: PendingTurnLifecycleDeps) {
  const now = deps.now ?? (() => Date.now());
  const ackTimeoutMs = deps.ackTimeoutMs ?? 60_000;
  const graceMs = deps.graceMs ?? 60_000;
  const entries = new Map<string, PendingTurnEntry>();

  function clearAckTimer(entry: PendingTurnEntry): void {
    if (entry.ackTimer !== undefined) {
      clearTimeout(entry.ackTimer);
      entry.ackTimer = undefined;
    }
  }

  function disposeEntry(runId: string, reason?: string): void {
    const entry = entries.get(runId);
    if (!entry) return;
    clearTimeout(entry.overallTimer);
    clearAckTimer(entry);
    entries.delete(runId);
    if (reason) deps.onAbandon?.(runId, reason);
  }

  function publishFinished(entry: PendingTurnEntry): void {
    if (entry.published || !entry.terminal) return;
    entry.published = true;
    // finalMessageId 只在真实落盘确认存在时携带；绝不用会话当前最后一条消息补齐
    const finalMessageId = entry.persistenceAck?.finalMessageId;
    deps.publisher.publishTurnFinished({
      source: "desktop",
      runId: entry.input.runId,
      mode: entry.input.mode,
      conversationId: entry.input.conversationId,
      inputMessageId: entry.input.inputMessageId,
      ...(finalMessageId ? { finalMessageId } : {}),
      status: entry.terminal.status,
      ...(entry.terminal.durationMs !== undefined ? { durationMs: entry.terminal.durationMs } : {}),
    });
    disposeEntry(entry.input.runId);
  }

  function beginTurn(input: PendingTurnInput): void {
    // 未知用户消息 ID 时无法构造桌面轮次事件边界，整轮跳过（诊断）
    if (!input.inputMessageId) {
      deps.onAbandon?.(input.runId, "missing inputMessageId");
      return;
    }
    disposeEntry(input.runId);
    const createdAt = now();
    const lifetime = (input.runTimeoutMs ?? 0) + graceMs;
    const entry: PendingTurnEntry = {
      input,
      createdAt,
      expiresAt: createdAt + lifetime,
      published: false,
      overallTimer: setTimeout(() => {
        disposeEntry(input.runId, "lifetime expired");
      }, Math.max(lifetime, 0)),
    };
    // 计时器不阻止主进程退出
    entry.overallTimer.unref?.();
    entries.set(input.runId, entry);
    deps.publisher.publishTurnStarted({
      source: "desktop",
      runId: input.runId,
      mode: input.mode,
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
    });
  }

  function settleTerminal(runId: string, terminal: PendingTurnTerminal): void {
    const entry = entries.get(runId);
    if (!entry) return;
    // 终态只认第一次（complete/error 双路径可能都调用）；成功结算后重复终态忽略
    if (entry.terminal) return;
    entry.terminal = terminal;
    if (entry.persistenceAck) {
      publishFinished(entry);
      return;
    }
    // 终态已到但落盘确认未到：有限等待，超时放弃（at-most-once）
    entry.ackTimer = setTimeout(() => {
      disposeEntry(runId, "persistence ack timeout");
    }, ackTimeoutMs);
    entry.ackTimer.unref?.();
  }

  function confirmPersistence(runId: string, ack: PendingTurnPersistenceAck): void {
    const entry = entries.get(runId);
    if (!entry) return;
    if (entry.published) return;
    entry.persistenceAck = ack;
    if (entry.terminal) {
      publishFinished(entry);
    }
    // 确认先于终态到达：等终态再发布（整体期限兜底）
  }

  return {
    beginTurn,
    settleTerminal,
    confirmPersistence,
    disposeEntry,
    /** 应用关闭 / 渲染进程整体失效时清理全部条目，不发布任何事件。 */
    disposeAll(): void {
      for (const runId of [...entries.keys()]) {
        disposeEntry(runId);
      }
    },
    /** 测试专用：当前待结算条目数。 */
    pendingCount(): number {
      return entries.size;
    },
  };
}

export type PendingTurnLifecycle = ReturnType<typeof createPendingTurnLifecycle>;
