/**
 * reactChatWindow 会话状态机。
 *
 * 维护 reactChatWindow 的 Ready 状态与 pending sessionId 队列；
 * 行为语义："最新一个 sessionId 胜出"。
 *
 * 契约：
 *  - markLoading  → ready=false，不动 pending
 *  - markReady    → ready=true；返回并清空当前 pending
 *  - queueOrTake  → ready 时直接返回 sessionId；未 ready 时存入并返回 null
 *  - reset        → ready=false；pending=null
 *
 * 不依赖 Electron/Electron API，可在测试中独立验证。
 */

export interface ReactChatSessionDispatcher {
  markLoading(): void;
  markReady(): string | null;
  queueOrTake(sessionId: string): string | null;
  reset(): void;
  isReady(): boolean;
  getPending(): string | null;
}

export function createReactChatSessionDispatcher(): ReactChatSessionDispatcher {
  let ready = false;
  let pending: string | null = null;

  return {
    markLoading() {
      ready = false;
    },
    markReady() {
      ready = true;
      const value = pending;
      pending = null;
      return value;
    },
    queueOrTake(sessionId: string) {
      if (ready) return sessionId;
      pending = sessionId;
      return null;
    },
    reset() {
      ready = false;
      pending = null;
    },
    isReady() {
      return ready;
    },
    getPending() {
      return pending;
    },
  };
}
