// ChannelManager —— 渠道注册表 + 生命周期管理。
//
// 设计原则：
//   - Manager 只做"哪个渠道注册了、它们的启停状态"。不知道任何平台协议细节。
//   - 入站消息路径：adapters.onMessage → manager.handleIncoming(msg) → dispatcher。
//     实际转发由 dispatcher 负责；manager 只持有 dispatcher 的入口引用。
//   - 出站消息路径：dispatcher 拿到 outgoing 后调 adapter.send(outgoing)。
//   - Manager 不感知 sessionId、不感知 cap 降级、不感知 tool 调用 —— 全部下放。
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelId, ChannelStatus, IncomingMessage, OutgoingMessage } from "./types";
import { setAdapterHandler } from "./adapters/base";
import { logger, LogTag } from "../logger";

const LOG = "[ChannelManager]";

/** dispatcher 给 manager 的回调 —— 拿到入站消息后返回一个 outgoing 消息 */
export type DispatchFn = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;

export class ChannelManager {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private dispatchFn: DispatchFn | null = null;
  /** 启动后已开启的 adapter（start 成功的才会调 stop） */
  private startedAdapters = new Set<ChannelId>();

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  /** 注册 adapter（必须在 startAll 之前调用；重复 id 一律拒绝） */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`渠道 ${adapter.id} 已注册，禁止覆盖现有实例`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** 设置 dispatcher 入口。注册 adapter 时机不限，dispatcher 注入必须早于 startAll。 */
  setDispatcher(fn: DispatchFn): void {
    this.dispatchFn = fn;
    // 给所有已注册的 adapter 注入 handler
    for (const adapter of this.adapters.values()) {
      setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id));
    }
  }

  /** 启动所有已注册 adapter（失败的跳过、记 log） */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      // 跳过已启动的 adapter（插件注册渠道场景：registerChannelAdapter 已 startOne）
      if (this.startedAdapters.has(adapter.id)) continue;
      try {
        // 每次 start 前重新注入 handler（防止 setDispatcher 之前 adapter 已经被外部注入 null）
        if (this.dispatchFn) {
          setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id));
        }
        await adapter.start();
        this.startedAdapters.add(adapter.id);
        logger.info(LogTag.Channels, `started: ${adapter.id} (${adapter.displayName})`);
      } catch (err) {
        console.error(LOG, `渠道启动失败 [${adapter.id}]:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 注销 adapter：若已启动先 stop，再移除（运行时禁用插件渠道用） */
  async unregister(id: ChannelId): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    if (this.startedAdapters.has(id)) {
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
      this.startedAdapters.delete(id);
    }
    this.adapters.delete(id);
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }

  /** 启动单个 adapter（运行时启用插件渠道用） */
  async startOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    if (this.startedAdapters.has(id)) return;
    if (this.dispatchFn) {
      setAdapterHandler(adapter, this.makeAdapterHandler(id));
    }
    await adapter.start();
    this.startedAdapters.add(id);
    logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
  }

  /** 关闭所有已启动的 adapter */
  async stopAll(): Promise<void> {
    for (const id of this.startedAdapters) {
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
    }
    this.startedAdapters.clear();
  }

  getAdapter(channel: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  listChannels(): ChannelId[] {
    return Array.from(this.adapters.keys());
  }

  /** 给 UI 用：所有渠道的实时状态 */
  getAllStatus(): Record<ChannelId, ChannelStatus> {
    const out: Partial<Record<ChannelId, ChannelStatus>> = {};
    for (const [id, adapter] of this.adapters.entries()) {
      out[id] = adapter.getStatus();
    }
    return out as Record<ChannelId, ChannelStatus>;
  }

  private makeAdapterHandler(channel: ChannelId) {
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      if (!this.dispatchFn) {
        console.warn(LOG, `收到入站消息但 dispatcher 未注册 [${channel}]`);
        return null;
      }
      let outgoing: OutgoingMessage | null = null;
      try {
        outgoing = await this.dispatchFn(msg);
      } catch (err) {
        console.error(LOG, `dispatcher 处理失败 [${channel}]:`, err);
        return null;
      }
      // dispatcher 已经算好了回复，现在调 adapter.send() 真发出去
      // （之前漏了这一步，导致回复算出来但不发，agent 静默无响应）
      if (outgoing) {
        const adapter = this.adapters.get(channel);
        if (adapter && adapter.send) {
          try {
            const result = await adapter.send(outgoing);
            if (!result.ok) {
              console.warn(LOG, `adapter.send 失败 [${channel}]:`, result.error);
            }
          } catch (err) {
            console.error(LOG, `adapter.send 抛错 [${channel}]:`, err);
          }
        } else {
          console.warn(LOG, `找不到 adapter 或 adapter 不支持 send [${channel}]`);
        }
      }
      return outgoing;
    };
  }
}

/** 进程级单例。index.ts 在 app.whenReady() 里实例化一次。 */
export const channelManager = new ChannelManager();
