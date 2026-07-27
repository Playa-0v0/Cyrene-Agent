// 後臺 LLM 調用串行隊列 + 限流自動重試。
//
// 背景：主聊天結束後，MemoryJudge 和心情觀察器併發打 LLM 請求，
// 加上主聊天本身的請求，三個調用同時打到一個 key 上，觸發廠商 RPM 限流。
//
// 設計：
// - 主聊天**不入隊**（用戶感知優先，照常即時發）
// - 後臺 LLM 調用（MemoryJudge / 心情觀察 / 未來的 Reflection）入隊，FIFO 串行
// - 隊列裡檢測限流錯誤，退避 5s 重試 1 次；其他錯誤直接放棄
// - 不依賴第三方限流庫（p-queue 等），項目內 ~50 行能搞定

const LOG_PREFIX = "[LLMQueue]";
const RETRY_DELAY_MS = 5_000;
const MAX_PENDING_TASKS = 50;
let pendingTasks = 0;
let runningTasks = 0;

/** 限流錯誤關鍵詞。任一命中視為可重試。 */
const RATE_LIMIT_KEYWORDS = [
  "rate limit",
  "速率限制",
  "頻率",
  "too many requests",
  "429",
  "rate_limit",
  "ratelimit",
];

/** 判斷錯誤是否為限流（可退避重試）。 */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return RATE_LIMIT_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

// 隊列內部用一個 promise chain 實現 FIFO 串行。
// 每次 enqueue 把任務掛在 tail 後面，tail 更新到這個任務。
// 這樣多個 enqueue 調用會自然串行，不需要鎖。
let tail: Promise<unknown> = Promise.resolve();

/**
 * 入隊一個後臺 LLM 任務。FIFO 串行執行；限流時自動退避 5s 重試 1 次。
 *
 * @param label 任務名（用於日誌）
 * @param task  返回 Promise 的任務函數
 * @returns 任務結果的 Promise；失敗時 reject，調用方自己處理（一般 .catch 吞掉，不影響主流程）
 */
export function enqueueLLMTask<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (pendingTasks >= MAX_PENDING_TASKS) {
    return Promise.reject(new Error(`背景任務佇列已達上限（${MAX_PENDING_TASKS}）`));
  }
  pendingTasks += 1;
  const next = tail.then(async (): Promise<T> => {
    pendingTasks -= 1;
    runningTasks += 1;
    try { return await runWithRetry(label, task); }
    finally { runningTasks -= 1; }
  });
  // tail 必須包住錯誤，否則一個失敗的任務會讓整條鏈斷（後續任務永遠不執行）
  tail = next.catch(() => {
    // 吞錯誤，不讓鏈斷；調用方仍然能從 next 拿到 reject
  });
  return next;
}

export function getLLMQueueStatus(): { pending: number; running: number; limit: number } {
  return { pending: pendingTasks, running: runningTasks, limit: MAX_PENDING_TASKS };
}

/** 執行任務，限流時退避 5s 重試 1 次。 */
async function runWithRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(LOG_PREFIX, "開始執行:", label);
  try {
    const result = await task();
    console.log(LOG_PREFIX, "完成:", label, "耗時=" + (Date.now() - startedAt) + "ms");
    return result;
  } catch (err) {
    if (!isRateLimitError(err)) {
      // 非限流錯誤直接拋，不重試
      console.warn(LOG_PREFIX, "失敗（非限流，不重試）:", label, err instanceof Error ? err.message : String(err));
      throw err;
    }
    // 限流：退避 5s 重試 1 次
    console.warn(LOG_PREFIX, "限流，" + (RETRY_DELAY_MS / 1000) + "s 後重試 1 次:", label);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await task();
      console.log(LOG_PREFIX, "重試成功:", label, "總耗時=" + (Date.now() - startedAt) + "ms");
      return result;
    } catch (retryErr) {
      console.error(LOG_PREFIX, "重試仍失敗，放棄:", label, retryErr instanceof Error ? retryErr.message : String(retryErr));
      throw retryErr;
    }
  }
}
