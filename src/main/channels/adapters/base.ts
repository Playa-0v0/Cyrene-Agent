// ChannelAdapter —— 每個外部渠道（微信/飛書/...）的協議適配層接口。
//
// 設計原則：adapter 負責兩件事：
//   1) start(): 註冊 webhook / 啟動子進程 / 加載本地狀態
//   2) send(): 把統一 OutgoingMessage 翻譯成平臺協議發出去
// 入站消息由 adapter 內部調用 onMessage 回調拋給 manager → dispatcher。
//
// 注意：adapter 不應該直接調 CyreneAgent；那是 dispatcher 的職責。
// adapter 只做"翻譯 + 協議收發 + 賬號/憑證管理"。
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

  /** 啟動：註冊 webhook / 啟子進程 / 加載憑證 / 寫運行時配置 */
  start(): Promise<void>;

  /** 關閉：停止子進程 / 關閉 webhook 監聽 / flush 隊列 */
  stop(): Promise<void>;

  /** Manager 在 start() 之前注入；adapter 把入站消息通過這個回調拋給 dispatcher */
  onMessage: MessageHandler | null;

  /** 出站：把統一 OutgoingMessage 翻譯成平臺協議發出去 */
  send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }>;

  /** UI 展示用狀態。輪詢調用，adapter 內部緩存即可。 */
  getStatus(): ChannelStatus;
}

/** 工具類型：adapter 的可選 onMessage setter。 */
export function setAdapterHandler(
  adapter: ChannelAdapter,
  handler: MessageHandler | null,
): void {
  adapter.onMessage = handler;
}