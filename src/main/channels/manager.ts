// ChannelManager —— 渠道註冊表 + 生命週期管理。
//
// 設計原則：
//   - Manager 只做"哪個渠道註冊了、它們的啟停狀態"。不知道任何平臺協議細節。
//   - 入站消息路徑：adapters.onMessage → manager.handleIncoming(msg) → dispatcher。
//     實際轉發由 dispatcher 負責；manager 只持有 dispatcher 的入口引用。
//   - 出站消息路徑：dispatcher 拿到 outgoing 後調 adapter.send(outgoing)。
//   - Manager 不感知 sessionId、不感知 cap 降級、不感知 tool 調用 —— 全部下放。
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelId, ChannelStatus, IncomingMessage, OutgoingMessage } from "./types";
import { setAdapterHandler } from "./adapters/base";

const LOG = "[ChannelManager]";

/** dispatcher 給 manager 的回調 —— 拿到入站消息後返回一個 outgoing 消息 */
export type DispatchFn = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;

export class ChannelManager {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private dispatchFn: DispatchFn | null = null;
  /** 啟動後已開啟的 adapter（start 成功的才會調 stop） */
  private startedAdapters = new Set<ChannelId>();

  /** 註冊 adapter（必須在 startAll 之前調用） */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      console.warn(LOG, `渠道 ${adapter.id} 已註冊，覆蓋舊實例`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** 設置 dispatcher 入口。註冊 adapter 時機不限，dispatcher 注入必須早於 startAll。 */
  setDispatcher(fn: DispatchFn): void {
    this.dispatchFn = fn;
    // 給所有已註冊的 adapter 注入 handler
    for (const adapter of this.adapters.values()) {
      setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id));
    }
  }

  /** 啟動所有已註冊 adapter（失敗的跳過、記 log） */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        // 每次 start 前重新注入 handler（防止 setDispatcher 之前 adapter 已經被外部注入 null）
        if (this.dispatchFn) {
          setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id));
        }
        await adapter.start();
        this.startedAdapters.add(adapter.id);
        console.log(LOG, `渠道啟動: ${adapter.id} (${adapter.displayName})`);
      } catch (err) {
        console.error(LOG, `渠道啟動失敗 [${adapter.id}]:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 關閉所有已啟動的 adapter */
  async stopAll(): Promise<void> {
    for (const id of this.startedAdapters) {
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失敗 [${id}]:`, err instanceof Error ? err.message : err);
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

  /** 執行 dispatcher 但不發送文字；Discord 語音通話用它取得語音回答。 */
  async dispatchOnly(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    if (!this.dispatchFn) {
      console.warn(LOG, `收到入站消息但 dispatcher 未註冊 [${msg.channel}]`);
      return null;
    }
    return await this.dispatchFn(msg);
  }

  /** 給 UI 用：所有渠道的實時狀態 */
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
        console.warn(LOG, `收到入站消息但 dispatcher 未註冊 [${channel}]`);
        return null;
      }
      let outgoing: OutgoingMessage | null = null;
      try {
        outgoing = await this.dispatchFn(msg);
      } catch (err) {
        console.error(LOG, `dispatcher 處理失敗 [${channel}]:`, err);
        return null;
      }
      // dispatcher 已經算好了回覆，現在調 adapter.send() 真發出去
      // （之前漏了這一步，導致回覆算出來但不發，agent 靜默無響應）
      if (outgoing) {
        const adapter = this.adapters.get(channel);
        if (adapter && adapter.send) {
          try {
            const result = await adapter.send(outgoing);
            if (!result.ok) {
              console.warn(LOG, `adapter.send 失敗 [${channel}]:`, result.error);
            }
          } catch (err) {
            console.error(LOG, `adapter.send 拋錯 [${channel}]:`, err);
          }
        } else {
          console.warn(LOG, `找不到 adapter 或 adapter 不支持 send [${channel}]`);
        }
      }
      return outgoing;
    };
  }
}

/** 進程級單例。index.ts 在 app.whenReady() 裡實例化一次。 */
export const channelManager = new ChannelManager();
