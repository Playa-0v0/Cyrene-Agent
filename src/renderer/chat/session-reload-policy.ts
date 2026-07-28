// chats:changed 广播到达后，如何处理"当前"会话的决策策略。
//
// 抽成纯函数是为了可测：main.ts 的 onChanged 回调依赖大量 DOM / IPC 副作用，
// 无法直接对"发送期间不该重载"这种竞态写单测。决策逻辑集中到这里，main.ts
// 只负责收集入参并按返回值执行。
//
// 背景：只有 proactive-chat 会话会在运行时被主进程外部追加主动消息，因此只有
// 它需要在收到外部变更广播时重载当前会话。但用户正在回复时（sending=true），
// 立刻重载会把刚 push 的 transient 思考消息（未持久化）清掉、把刚落库的模型
// 回复冲掉。所以发送期间到达的外部变更要 defer，等发送结束、最终 saveSession
// 落盘后再重载。普通会话不在此重载，天然免疫。
//
// 来源隔离在主进程侧做（chats-ipc.broadcastChanged 跳过发起方）：本窗口自己的
// saveSession 广播不会回到本窗口，所以这里收到的都是"真正的外部变更"。

export type ReloadDecision = "reload" | "defer" | "skip";

export interface ReloadCurrentSessionInput {
  /** 当前会话的 purpose；普通会话为 undefined / 其它值。 */
  purpose?: string;
  /** store 里当前会话的最新 updatedAt。 */
  updatedAt: number;
  /** 本窗口上次载入该会话时记录的 updatedAt。 */
  seenAt: number;
  /** 是否正处于发送期间（用户消息已入列、模型回复未落库）。 */
  sending: boolean;
}

/**
 * 决定收到 chats:changed 后对当前会话的动作：
 * - "reload"：非发送期间的外部主动消息追加，立即从磁盘重载。
 * - "defer" ：发送期间到达的外部变更，排队等发送结束再重载（避免冲掉 transient
 *             思考消息和刚落库的回复）。
 * - "skip"  ：非 proactive-chat 会话，或 updatedAt 未增长，无需重载。
 */
export function decideReloadCurrentSession(input: ReloadCurrentSessionInput): ReloadDecision {
  if (input.purpose !== "proactive-chat") return "skip";
  if (input.updatedAt <= input.seenAt) return "skip";
  if (input.sending) return "defer";
  return "reload";
}
