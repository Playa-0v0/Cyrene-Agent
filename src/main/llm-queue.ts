// 后台 LLM 调用串行队列 + 限流自动重试。
//
// 背景：主聊天结束后，MemoryJudge 和心情观察器并发打 LLM 请求，
// 加上主聊天本身的请求，三个调用同时打到一个 key 上，触发厂商 RPM 限流。
//
// 设计：
// - 主聊天**不入队**（用户感知优先，照常即时发）
// - 后台 LLM 调用（MemoryJudge / 心情观察 / 未来的 Reflection）入队，FIFO 串行
// - 队列里检测限流错误，退避 5s 重试 1 次；其他错误直接放弃
// - 不依赖第三方限流库（p-queue 等），项目内 ~50 行能搞定

const LOG_PREFIX = "[LLMQueue]";
const RETRY_DELAY_MS = 5_000;

/** 限流错误关键词。任一命中视为可重试。 */
const RATE_LIMIT_KEYWORDS = [
  "rate limit",
  "速率限制",
  "频率",
  "too many requests",
  "429",
  "rate_limit",
  "ratelimit",
];

/** 判断错误是否为限流（可退避重试）。 */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return RATE_LIMIT_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

// 队列内部用一个 promise chain 实现 FIFO 串行。
// 每次 enqueue 把任务挂在 tail 后面，tail 更新到这个任务。
// 这样多个 enqueue 调用会自然串行，不需要锁。
let tail: Promise<unknown> = Promise.resolve();

/**
 * 入队一个后台 LLM 任务。FIFO 串行执行；限流时自动退避 5s 重试 1 次。
 *
 * @param label 任务名（用于日志）
 * @param task  返回 Promise 的任务函数
 * @returns 任务结果的 Promise；失败时 reject，调用方自己处理（一般 .catch 吞掉，不影响主流程）
 */
export function enqueueLLMTask<T>(
  label: string,
  task: () => Promise<T>,
  options: { log?: boolean; retryRateLimit?: boolean } = {},
): Promise<T> {
  const next = tail.then(async (): Promise<T> => {
    return runWithRetry(
      label,
      task,
      options.log !== false,
      options.retryRateLimit !== false,
    );
  });
  // tail 必须包住错误，否则一个失败的任务会让整条链断（后续任务永远不执行）
  tail = next.catch(() => {
    // 吞错误，不让链断；调用方仍然能从 next 拿到 reject
  });
  return next;
}

/** 执行任务，限流时退避 5s 重试 1 次。 */
async function runWithRetry<T>(
  label: string,
  task: () => Promise<T>,
  logEnabled: boolean,
  retryRateLimit: boolean,
): Promise<T> {
  const startedAt = Date.now();
  if (logEnabled) console.log(LOG_PREFIX, "开始执行:", label);
  try {
    const result = await task();
    if (logEnabled) console.log(LOG_PREFIX, "完成:", label, "耗时=" + (Date.now() - startedAt) + "ms");
    return result;
  } catch (err) {
    if (!retryRateLimit || !isRateLimitError(err)) {
      // 非限流错误直接抛，不重试
      if (logEnabled) console.warn(LOG_PREFIX, "失败（非限流，不重试）:", label, err instanceof Error ? err.message : String(err));
      throw err;
    }
    // 限流：退避 5s 重试 1 次
    if (logEnabled) console.warn(LOG_PREFIX, "限流，" + (RETRY_DELAY_MS / 1000) + "s 后重试 1 次:", label);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await task();
      if (logEnabled) console.log(LOG_PREFIX, "重试成功:", label, "总耗时=" + (Date.now() - startedAt) + "ms");
      return result;
    } catch (retryErr) {
      if (logEnabled) console.error(LOG_PREFIX, "重试仍失败，放弃:", label, retryErr instanceof Error ? retryErr.message : String(retryErr));
      throw retryErr;
    }
  }
}
