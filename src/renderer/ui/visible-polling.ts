export interface VisiblePollingOptions {
  /** 顯示於診斷訊息的任務名稱。 */
  label?: string;
  /** 建立輪詢器時立刻執行一次。 */
  runImmediately?: boolean;
}

/**
 * 只在頁面可見時執行的輪詢器。
 *
 * Electron 的多窗口在隱藏後仍會存活；直接 setInterval 會持續發 IPC，
 * 也可能在上一輪尚未完成時疊加下一輪。這個 helper 統一處理兩種情況。
 */
export function startVisiblePolling(
  task: () => Promise<void> | void,
  intervalMs: number,
  options: VisiblePollingOptions = {},
): () => void {
  let running = false;
  let stopped = false;

  const run = async () => {
    if (stopped || document.hidden || running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.warn(`[polling] ${options.label ?? "task"} failed:`, error);
    } finally {
      running = false;
    }
  };

  const timer = window.setInterval(() => void run(), intervalMs);
  const onVisibilityChange = () => {
    if (!document.hidden) void run();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  if (options.runImmediately) void run();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
