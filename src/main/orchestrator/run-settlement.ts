/**
 * Exactly-once settlement gate：保证一次 run 只记账一个终态。
 *
 * 职责：
 * - 在一次 run 的生命周期内，只允许第一个 CyreneRunTerminalResult 被记账。
 * - 任何后续 trySettle（包括 success 后再 error、cancelled 后再 timeout 等）
 *   都被静默丢弃，由调用方决定是否记录诊断日志。
 *
 * 不承担的职责：
 * - 不判断 completion / continue_agent；
 * - 不修改 RUN_FINISHED.result 的形状（只记账，不重写）；
 * - 不消费 ExecutionLedger / UncertainEffectGuard；
 * - 不参与取消传播（取消走各 run 的 AbortController，见 agui-bridge）。
 *
 * 使用方：
 * - agui-bridge：complete / error 两条 RxJS 回调在转发终态事件前都先调 trySettle，
 *   只有第一次进入的那条会真正发出 RUN_FINISHED / RUN_ERROR。
 * - 测试：直接构造 RunSettlementGate 实例，验证状态机。
 */

import type { CyreneRunTerminalResult } from "../../shared/run-terminal";

export class RunSettlementGate {
  private settlement: CyreneRunTerminalResult | null = null;

  /**
   * 尝试登记一个终态结算。
   * @returns true 表示这是第一次结算（调用方应据此发出终态事件）；
   *          false 表示已经有终态被记账，本次调用被丢弃。
   */
  trySettle(result: CyreneRunTerminalResult): boolean {
    if (this.settlement) return false;
    this.settlement = result;
    return true;
  }

  /** 取回第一次记账的终态；尚未结算时返回 null。 */
  get(): CyreneRunTerminalResult | null {
    return this.settlement;
  }

  /** 便捷方法：是否已经结算过。 */
  isSettled(): boolean {
    return this.settlement !== null;
  }
}
