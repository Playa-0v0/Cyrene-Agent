/**
 * 后台启动阶段（backgroundReady）：不阻塞首屏的软启动。
 * 所有后台任务交给 BackgroundTaskRunner 跟踪：每项任务获得 AbortSignal、
 * 退出时 abort 并等待/放弃，迟到完成的任务立即执行其返回的 dispose。
 *
 * 依赖组（A–D 并发；组内箭头为严格顺序）：
 *   A: MCP 清理 → 内置同步 → MCP 恢复（30s 屏障）→ channels 启动 → scheduler 启动 → 主动触发器
 *   B: 记忆协调 → 向量索引刷新 → 重排序器预热
 *   C: 截图预热
 *   D: 更新检查
 * 全部组结算后推进 ready；失败进入 degradedReasons，不阻塞聊天。
 */

import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { CoreResult } from "./core-bootstrap";
import type { ChannelsSubsystem } from "../channels/bootstrap";
import type { SchedulerSubsystem } from "../scheduler/bootstrap";

/** MCP 恢复屏障总超时；超时后 channels/scheduler 仍可启动，MCP 标记降级。 */
export const MCP_RESTORE_BARRIER_TIMEOUT_MS = 30_000;

export interface BackgroundDependencies {
  core: CoreResult;
  channels: ChannelsSubsystem;
  scheduler: SchedulerSubsystem;
  readiness: StartupReadiness;
  shutdown: ShutdownCoordinator;
  pruneRemovedMcp(signal: AbortSignal): Promise<void>;
  syncBuiltInMcp(signal: AbortSignal): Promise<void>;
  restoreMcp(signal: AbortSignal): Promise<void>;
  reconcileMemory(signal: AbortSignal): Promise<void>;
  scheduleEmbeddingRefresh(signal: AbortSignal): Promise<{ dispose(): void } | void>;
  initializeReranker(signal: AbortSignal): Promise<void>;
  prewarmScreenshot(signal: AbortSignal): Promise<void>;
  scheduleUpdateCheck(signal: AbortSignal): Promise<{ dispose(): void } | void>;
  startProactiveTrigger(signal: AbortSignal): Promise<{ dispose(): void } | void>;
}

export interface BackgroundHandle {
  /** 全部依赖组结算（成功/失败/超时）后 resolve，并推进 readiness 到 ready。 */
  settled: Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
}

export interface BackgroundTaskRunner {
  run<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  stop(signal?: AbortSignal): Promise<void>;
}

function disposeLateResult(result: unknown): void {
  const disposer = result as { dispose?: unknown } | null | undefined;
  if (disposer && typeof disposer.dispose === "function") {
    try {
      (disposer as { dispose(): void }).dispose();
    } catch (error) {
      console.error("[Background] late dispose failed:", error);
    }
  }
}

/**
 * 跟踪式后台任务运行器：
 * - run() 在 runner 停止后拒绝新任务；
 * - stop() abort 共享信号，等待已注册任务结算（最多等到传入的 shutdown 信号）；
 * - 停止后完成的任务若返回 { dispose() }，立即调用，保证无所有者资源不残留。
 */
export function createBackgroundTaskRunner(): BackgroundTaskRunner {
  const controller = new AbortController();
  const entries = new Map<string, RunnerEntry>();
  let stopped = false;

  return {
    run<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (stopped) {
        return Promise.reject(new Error(`background runner stopped: task ${id} not started`));
      }
      const promise = task(controller.signal).then(
        (result) => {
          entries.delete(id);
          // 停止后才结算的任务：立即清理其返回的资源，避免产生无所有者资源
          if (stopped) disposeLateResult(result);
          return result;
        },
        (error) => {
          entries.delete(id);
          throw error;
        },
      );
      entries.set(id, { id, promise });
      return promise;
    },

    async stop(signal?: AbortSignal): Promise<void> {
      stopped = true;
      controller.abort();
      const pending = [...entries.values()];
      if (pending.length === 0) return;
      const waitAll = Promise.allSettled(pending.map((entry) => entry.promise.catch(() => undefined)));
      if (signal) {
        const abortPromise = new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([waitAll, abortPromise]);
      } else {
        await waitAll;
      }
    },
  };
}

interface RunnerEntry {
  id: string;
  promise: Promise<unknown>;
}

type OptionalDisposer = { dispose(): void } | void | undefined;

function disposeOptional(disposer: OptionalDisposer): void {
  if (disposer && typeof disposer.dispose === "function") disposer.dispose();
}

export function startBackground(deps: BackgroundDependencies): BackgroundHandle {
  const { readiness, shutdown, channels, scheduler } = deps;
  const runner = createBackgroundTaskRunner();

  let proactiveTriggerDisposer: OptionalDisposer;
  let updateCheckDisposer: OptionalDisposer;
  let embeddingRefreshDisposer: OptionalDisposer;

  const isShuttingDown = (): boolean => {
    const phase = readiness.getPhase();
    return phase === "stopping" || phase === "stopped" || phase === "failed";
  };

  /** 启动耗时埋点：打印任务耗时与结束时刻（相对进程启动），供启动性能排查。 */
  function logStartupTiming(label: string, start: number): void {
    const end = performance.now();
    console.log(`[StartupTiming] ${label} ${Math.round(end - start)}ms (at ${Math.round(end)}ms)`);
  }

  /** 单项后台任务：失败记录降级（退出中导致的失败只记录日志），不阻塞组内后继。 */
  async function runTracked<T>(
    id: string,
    capability: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const start = performance.now();
    try {
      const result = await runner.run(id, task);
      logStartupTiming(`bg/${id}`, start);
      return result;
    } catch (error) {
      if (isShuttingDown()) {
        console.warn(`[Background] ${id} aborted during shutdown`);
        return undefined;
      }
      console.error(`[Background] ${id} failed:`, error);
      readiness.markDegraded({
        capability,
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
        error,
      });
      return undefined;
    }
  }

  // 退出注册：quiesce 中止后台启动；stopProducers 停止周期性生产者。
  // 任务尚未结算时，其迟到返回的 dispose 由 runner 兜底调用。
  shutdown.register({
    id: "background-runner",
    phase: "quiesce",
    dispose: (signal) => runner.stop(signal),
  });
  shutdown.register({
    id: "proactive-trigger",
    phase: "stopProducers",
    dispose: async () => { disposeOptional(proactiveTriggerDisposer); },
  });
  shutdown.register({
    id: "scheduler",
    phase: "stopProducers",
    dispose: async () => { scheduler.stop(); },
  });
  shutdown.register({
    id: "embedding-refresh",
    phase: "stopProducers",
    dispose: async () => { disposeOptional(embeddingRefreshDisposer); },
  });
  shutdown.register({
    id: "update-check-timer",
    phase: "stopProducers",
    dispose: async () => { disposeOptional(updateCheckDisposer); },
  });

  async function groupA(): Promise<void> {
    await runTracked("mcp-prune", "mcp", (signal) => deps.pruneRemovedMcp(signal));
    await runTracked("mcp-sync-builtin", "mcp", (signal) => deps.syncBuiltInMcp(signal));

    // MCP 恢复屏障：等待“恢复尝试已结算”（成功/失败/30s 超时）。
    // 超时不让底层任务失去所有权 —— 恢复任务继续在 runner 内跟踪。
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    const barrierTimeout = new Promise<"timeout">((resolve) => {
      barrierTimer = setTimeout(() => resolve("timeout"), MCP_RESTORE_BARRIER_TIMEOUT_MS);
    });
    const restoreResult = await Promise.race([
      runTracked("mcp-restore", "mcp", (signal) => deps.restoreMcp(signal)).then(() => "settled" as const),
      barrierTimeout,
    ]);
    if (barrierTimer !== undefined) clearTimeout(barrierTimer);
    if (restoreResult === "timeout") {
      console.error(`[Background] MCP restore barrier timeout after ${MCP_RESTORE_BARRIER_TIMEOUT_MS}ms; continuing degraded`);
      readiness.markDegraded({
        capability: "mcp",
        message: `MCP restore barrier timeout after ${MCP_RESTORE_BARRIER_TIMEOUT_MS}ms`,
        at: Date.now(),
      });
    }

    // MCP 结算后：channels 网络启动 → scheduler 定时器 → 主动触发器
    await runTracked("channels-start", "channels", async (signal) => {
      if (signal.aborted) throw new Error("aborted before channels start");
      await channels.start(signal);
    });
    await runTracked("scheduler-start", "scheduler", (signal) => {
      if (signal.aborted) throw new Error("aborted before scheduler start");
      scheduler.start();
      return Promise.resolve();
    });
    await runTracked("proactive-trigger", "proactive", async (signal) => {
      if (signal.aborted) throw new Error("aborted before proactive trigger start");
      proactiveTriggerDisposer = await deps.startProactiveTrigger(signal);
    });
  }

  async function groupB(): Promise<void> {
    await runTracked("memory-reconcile", "memory", (signal) => deps.reconcileMemory(signal));
    await runTracked("embedding-refresh", "embedding", async (signal) => {
      embeddingRefreshDisposer = await deps.scheduleEmbeddingRefresh(signal);
    });
    await runTracked("reranker-init", "reranker", (signal) => deps.initializeReranker(signal));
  }

  async function groupC(): Promise<void> {
    await runTracked("screenshot-prewarm", "screenshot", (signal) => deps.prewarmScreenshot(signal));
  }

  async function groupD(): Promise<void> {
    await runTracked("update-check", "update-check", async (signal) => {
      updateCheckDisposer = await deps.scheduleUpdateCheck(signal);
    });
  }

  const settled = (async () => {
    await Promise.allSettled([groupA(), groupB(), groupC(), groupD()]);
    try {
      if (readiness.getPhase() === "background-starting") {
        readiness.transition("ready");
      }
    } catch (error) {
      console.warn("[Background] readiness transition to ready failed:", error);
    }
  })();

  return {
    settled,
    stop: (signal?: AbortSignal) => runner.stop(signal),
  };
}
