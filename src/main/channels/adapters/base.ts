// ChannelAdapter —— 每个外部渠道（微信/飞书/...）的协议适配层接口。
//
// 设计原则：adapter 负责两件事：
//   1) start(): 注册 webhook / 启动子进程 / 加载本地状态
//   2) send(): 把统一 OutgoingMessage 翻译成平台协议发出去
// 入站消息由 adapter 内部调用 onMessage 回调抛给 manager → dispatcher。
//
// 注意：adapter 不应该直接调 CyreneAgent；那是 dispatcher 的职责。
// adapter 只做"翻译 + 协议收发 + 账号/凭证管理"。
import type {
  ChannelCapability,
  ChannelId,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
} from "../types";

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly capability: ChannelCapability;

  /** 启动：注册 webhook / 启子进程 / 加载凭证 / 写运行时配置 */
  start(): Promise<void>;

  /** 关闭：停止子进程 / 关闭 webhook 监听 / flush 队列 */
  stop(): Promise<void>;

  /** Manager 在 start() 之前注入；adapter 把入站消息通过这个回调抛给 dispatcher */
  onMessage: MessageHandler | null;

  /** 出站：把统一 OutgoingMessage 翻译成平台协议发出去 */
  send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }>;

  /** UI 展示用状态。轮询调用，adapter 内部缓存即可。 */
  getStatus(): ChannelStatus;
}

/** 工具类型：adapter 的可选 onMessage setter。 */
export function setAdapterHandler(
  adapter: ChannelAdapter,
  handler: MessageHandler | null,
): void {
  adapter.onMessage = handler;
}