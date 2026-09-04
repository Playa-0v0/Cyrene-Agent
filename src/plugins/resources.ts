/**
 * 插件资源统一跟踪器。
 *
 * 所有由 PluginContext 登记的临时宿主资源（工具、渠道、IPC、事件订阅、
 * 提示词 Provider、onDispose 回调、未来的语音租约等）都进入同一个
 * 跟踪器，保证它们共用一套停止、回滚和逆序清理路径：
 *
 * - dispose() 按注册的逆序执行清理；
 * - 每个清理函数最多被调用一次（手动注销和 dispose 互斥）；
 * - 单项清理超时或失败只记日志，不阻止其余资源继续释放；
 * - 跟踪器停止后拒绝登记新资源。
 *
 * 持久化资源（例如插件创建的调度任务）不属于临时句柄，不登记到此处；
 * 它们的生命周期由所有权字段和卸载流程管理。
 */
import { runPluginCleanup } from "./cleanup";

export type PluginResourceCleanup = () => void | Promise<void>;

export interface PluginResourceTracker {
  /** 登记一项资源；kind 用于诊断归类，key 在同 kind 内唯一。 */
  track(kind: string, key: string, cleanup: PluginResourceCleanup): void;
  /** 手动注销：执行该资源的清理并从跟踪器移除；未登记返回 false。 */
  release(kind: string, key: string): Promise<boolean>;
  /** 不执行清理，仅从跟踪器移除（调用方已完成清理时使用）。 */
  forget(kind: string, key: string): boolean;
  /** 是否已登记指定资源。 */
  has(kind: string, key: string): boolean;
  /** 按注册逆序释放全部剩余资源；重复调用共享同一个任务。 */
  dispose(): Promise<void>;
}

interface TrackedResource {
  kind: string;
  key: string;
  cleanup: PluginResourceCleanup;
  released: boolean;
}

export function createPluginResourceTracker(
  /** 单项资源清理失败或超时时的上报出口。 */
  onResourceError: (kind: string, key: string, error: unknown) => void = (kind, key, error) => {
    console.warn(`[plugin-resource] 清理 ${kind}:${key} 失败`, error);
  },
): PluginResourceTracker {
  const resources: TrackedResource[] = [];
  let stopped = false;
  // 缓存同一次释放任务，避免异步清理让出事件循环时发生并发重入。
  let disposePromise: Promise<void> | undefined;

  function find(kind: string, key: string): TrackedResource | undefined {
    return resources.find((resource) => resource.kind === kind && resource.key === key);
  }

  async function runCleanup(resource: TrackedResource): Promise<void> {
    if (resource.released) return;
    resource.released = true;
    // 标签只带 kind：错误进入统一告警时按资源类别定位即可。
    await runPluginCleanup(resource.cleanup, `插件资源 ${resource.kind}`);
  }

  return {
    track(kind, key, cleanup) {
      if (typeof cleanup !== "function") {
        throw new Error("插件资源清理函数必须是函数");
      }
      if (stopped) {
        throw new Error("插件停止后不能再登记资源");
      }
      if (find(kind, key)) {
        throw new Error(`插件资源已登记: ${kind}:${key}`);
      }
      resources.push({ kind, key, cleanup, released: false });
    },
    async release(kind, key) {
      const resource = find(kind, key);
      if (!resource || resource.released) return false;
      try {
        await runCleanup(resource);
      } finally {
        const index = resources.indexOf(resource);
        if (index >= 0) resources.splice(index, 1);
      }
      return true;
    },
    forget(kind, key) {
      const resource = find(kind, key);
      if (!resource) return false;
      const index = resources.indexOf(resource);
      if (index >= 0) resources.splice(index, 1);
      return true;
    },
    has(kind, key) {
      const resource = find(kind, key);
      return Boolean(resource) && !resource!.released;
    },
    dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          stopped = true;
          const pending = resources.splice(0).reverse();
          for (const resource of pending) {
            try {
              await runCleanup(resource);
            } catch (error) {
              onResourceError(resource.kind, resource.key, error);
            }
          }
        })();
      }
      return disposePromise;
    },
  };
}

export { PLUGIN_CLEANUP_TIMEOUT_MS, runPluginCleanup } from "./cleanup";
