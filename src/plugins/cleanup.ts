/** 单项第三方清理钩子的公共超时控制，供资源跟踪器和插件管理器共用。 */
export const PLUGIN_CLEANUP_TIMEOUT_MS = 5_000;

/** 等待单次第三方清理钩子；超时后抛错，让框架继续回收其余资源。 */
export async function runPluginCleanup(
  cleanup: () => void | Promise<void>,
  label: string,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // 保持既有语义：清理函数在调用 dispose/unregister 的当前轮同步开始执行。
    const cleanupPromise = Promise.resolve(cleanup());
    await Promise.race([
      cleanupPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} 清理超时（${PLUGIN_CLEANUP_TIMEOUT_MS}ms）`));
        }, PLUGIN_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
