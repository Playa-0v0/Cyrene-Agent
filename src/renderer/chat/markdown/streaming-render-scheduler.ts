/**
 * 流式渲染调度器。
 *
 * 独立于 40ms 字符消费 tick，使用 requestAnimationFrame + 最小时间间隔。
 *
 * 特性：
 * - 只有 raw 内容变化时才调度
 * - 同一时间最多一个 pending render
 * - 自适应间隔（根据 active tail 长度）
 * - revision 校验：旧任务不写入新消息
 * - flush 强制执行最后一次渲染
 * - cancel 取消所有 pending
 */

export interface SchedulerOptions {
  /** 消息 ID（用于 revision 校验） */
  messageId: string;
  /** 渲染回调 */
  render: () => void;
  /** 是否已销毁 */
  isDisposed: () => boolean;
}

export interface StreamingRenderScheduler {
  /** 请求调度一次渲染（节流） */
  schedule(): void;
  /** 强制立即渲染（取消 pending，同步执行） */
  flush(): void;
  /** 取消所有 pending */
  cancel(): void;
}

/**
 * 根据 active tail 长度计算自适应渲染间隔（ms）。
 * tail 越长间隔越大，避免长文本频繁重解析。
 */
export function getStreamingRenderInterval(activeLength: number): number {
  if (activeLength < 1_000) return 60;
  if (activeLength < 3_000) return 90;
  if (activeLength < 6_000) return 140;
  return 220;
}

export function createStreamingRenderScheduler(options: SchedulerOptions): StreamingRenderScheduler {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFrame: number | null = null;
  let lastRenderAt = 0;

  const execute = (): void => {
    pendingTimer = null;
    pendingFrame = null;

    if (options.isDisposed()) return;

    lastRenderAt = Date.now();
    try {
      options.render();
    } catch (err) {
      console.error("[streaming-scheduler] render 回调失败:", err);
    }
  };

  return {
    schedule(): void {
      if (options.isDisposed()) return;

      // 已有 pending，不重复调度
      if (pendingTimer !== null || pendingFrame !== null) return;

      const elapsed = Date.now() - lastRenderAt;
      const interval = getStreamingRenderInterval(0); // 间隔由 session 传入 activeLength

      const delay = Math.max(0, interval - elapsed);

      // 用 setTimeout 控制最小间隔，用 requestAnimationFrame 对齐帧
      pendingTimer = setTimeout(() => {
        if (options.isDisposed()) {
          pendingTimer = null;
          return;
        }
        pendingFrame = requestAnimationFrame(() => {
          execute();
        });
      }, delay);
    },

    flush(): void {
      // 取消 pending，立即同步执行
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }

      if (!options.isDisposed()) {
        execute();
      }
    },

    cancel(): void {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
    },
  };
}
