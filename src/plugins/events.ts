export type PluginEventBusListener = (payload: unknown) => void | Promise<void>;

const EVENT_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_EVENT_LISTENER_TIMEOUT_MS = 5_000;

/** 限制单个第三方事件监听器的执行时间，避免阻塞后续监听器或宿主停止流程。 */
async function runEventListener(
  listener: PluginEventBusListener,
  payload: unknown,
  event: string,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => listener(payload)),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`事件监听器 ${event} 执行超时（${PLUGIN_EVENT_LISTENER_TIMEOUT_MS}ms）`));
        }, PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * 普通发布的单个监听器派发：同步调用监听器，返回的 Promise 不阻塞派发循环。
 * 异步结果单独附加超时与错误日志；超时只忽略迟到结果，无法终止监听器自身的同步执行。
 */
function dispatchListener(
  listener: PluginEventBusListener,
  payload: unknown,
  event: string,
  onListenerError: (event: string, error: unknown) => void,
): void {
  let result: void | Promise<void>;
  try {
    result = listener(payload);
  } catch (error) {
    onListenerError(event, error);
    return;
  }
  if (!result || typeof (result as Promise<void>).then !== "function") return;
  let settled = false;
  const timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    onListenerError(event, new Error(`事件监听器 ${event} 异步执行超时（${PLUGIN_EVENT_LISTENER_TIMEOUT_MS}ms）`));
  }, PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
  // 旁路计时器不单独阻止主进程退出。
  timeoutHandle.unref?.();
  Promise.resolve(result).then(
    () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
    },
    (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      onListenerError(event, error);
    },
  );
}

function validateQualifiedEventName(event: string): void {
  // 完整事件只开放宿主和插件两类命名空间，避免无所有者的全局事件。
  const segments = event.split(":");
  if (segments.length < 2 || !segments.every((segment) => EVENT_SEGMENT_RE.test(segment))) {
    throw new Error(`非法插件事件名: ${event}`);
  }
  if (segments[0] !== "host" && segments[0] !== "plugin") {
    throw new Error(`插件事件名必须使用 host 或 plugin 命名空间: ${event}`);
  }
  if (segments[0] === "plugin" && segments.length < 3) {
    throw new Error(`plugin 事件名必须包含插件 id 和事件名: ${event}`);
  }
}

export interface PluginEventBus {
  on(event: string, listener: PluginEventBusListener): () => void;
  /**
   * 普通事件发布（旁路）：监听器在 setImmediate 宏任务中按快照顺序派发，
   * 发布函数返回时不在当前调用栈进入任何第三方监听器，也不等待监听器异步完成。
   * 返回的 Promise 在全部监听器已被调用后兑现。
   */
  emit(event: string, payload: unknown): Promise<void>;
  /**
   * 生命周期屏障发布：顺序等待每个监听器完成（含单个超时）后才返回。
   * 只供插件系统 ready/stopping 使用，普通宿主事件禁止走此阻塞入口。
   */
  emitLifecycleBarrier(event: string, payload: unknown): Promise<void>;
  clear(): void;
}

export function createPluginEventBus(
  onListenerError: (event: string, error: unknown) => void = (event, error) => {
    console.warn(`[plugins] 事件监听器处理 ${event} 失败`, error);
  },
): PluginEventBus {
  const listeners = new Map<string, Set<{ listener: PluginEventBusListener }>>();

  return {
    on(event, listener) {
      validateQualifiedEventName(event);
      if (typeof listener !== "function") throw new Error("插件事件监听器必须是函数");
      const eventListeners = listeners.get(event) ?? new Set<{ listener: PluginEventBusListener }>();
      const subscription = { listener };
      eventListeners.add(subscription);
      listeners.set(event, eventListeners);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        eventListeners.delete(subscription);
        if (eventListeners.size === 0) listeners.delete(event);
      };
    },
    emit(event, payload) {
      // 校验失败以 Promise 拒绝返回，保持与既有调用方的错误约定一致。
      return new Promise<void>((resolve, reject) => {
        try {
          validateQualifiedEventName(event);
        } catch (error) {
          reject(error);
          return;
        }
        // 固定本轮快照：监听器在回调中退订时，不改变已经开始的发布顺序。
        const snapshot = Array.from(listeners.get(event) ?? []);
        // 宏任务旁路：先把当前调用栈交还事件循环，监听器从后续调度任务开始执行。
        setImmediate(() => {
          for (const subscription of snapshot) {
            dispatchListener(subscription.listener, payload, event, onListenerError);
          }
          resolve();
        });
      });
    },
    async emitLifecycleBarrier(event, payload) {
      validateQualifiedEventName(event);
      // 固定本轮快照：监听器在回调中退订时，不改变已经开始的发布顺序。
      const snapshot = Array.from(listeners.get(event) ?? []);
      for (const subscription of snapshot) {
        try {
          await runEventListener(subscription.listener, payload, event);
        } catch (error) {
          onListenerError(event, error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

export function qualifyPluginEvent(pluginId: string, event: string): string {
  // 插件侧只接受单个短名称；所有者前缀由框架生成。
  if (!EVENT_SEGMENT_RE.test(event)) throw new Error(`非法插件自定义事件名: ${event}`);
  return `plugin:${pluginId}:${event}`;
}

export function qualifyHostEvent(event: string): string {
  // 宿主调用方传入主题即可，不能自行选择或覆盖根命名空间。
  const qualified = `host:${event}`;
  validateQualifiedEventName(qualified);
  return qualified;
}
