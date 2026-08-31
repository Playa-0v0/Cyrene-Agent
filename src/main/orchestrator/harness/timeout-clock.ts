/**
 * 双时钟超时管理（v3 §10.3 / §10.4）
 * 注：注释中的 "v3 §x" / "设计稿 §x" 均指 docs/design/2026-08-08-cyreneHarnessloopdesign.md（CyreneHarness 设计稿 v3）。
 *
 * 两个时钟：
 * - activeExecutionTime：工具执行 + LLM 调用时间（跑得快就允许跑更多轮）
 * - userWaitTime：ask_user 等待时间（不消耗执行预算）
 *
 * 超时判断：activeExecutionTime >= totalTimeoutMs
 * ask_user 期间暂停 activeExecutionTime 计时。
 */

export class TimeoutClock {
  private startTime: number;
  private accumulatedActiveMs: number = 0;
  private activeSessionStart: number | null = null;
  private userWaitStart: number | null = null;
  private accumulatedUserWaitMs: number = 0;

  constructor(
    private totalTimeoutMs: number,
    private userWaitTimeoutMs: number,
  ) {
    this.startTime = Date.now();
  }

  /** 开始执行计时（工具执行 / LLM 调用前） */
  startActive(): void {
    if (this.activeSessionStart === null) {
      this.activeSessionStart = Date.now();
    }
  }

  /** 暂停执行计时（ask_user 等待时） */
  stopActive(): void {
    if (this.activeSessionStart !== null) {
      this.accumulatedActiveMs += Date.now() - this.activeSessionStart;
      this.activeSessionStart = null;
    }
  }

  /** 开始用户等待计时（ask_user 调用时） */
  startUserWait(): void {
    this.stopActive();
    this.userWaitStart = Date.now();
  }

  /** 结束用户等待计时（ask_user 回答后） */
  stopUserWait(): void {
    if (this.userWaitStart !== null) {
      this.accumulatedUserWaitMs += Date.now() - this.userWaitStart;
      this.userWaitStart = null;
    }
    this.startActive();
  }

  /** 获取当前活跃执行时间（毫秒） */
  getActiveExecutionMs(): number {
    let total = this.accumulatedActiveMs;
    if (this.activeSessionStart !== null) {
      total += Date.now() - this.activeSessionStart;
    }
    return total;
  }

  /** 获取当前用户等待时间（毫秒） */
  getUserWaitMs(): number {
    let total = this.accumulatedUserWaitMs;
    if (this.userWaitStart !== null) {
      total += Date.now() - this.userWaitStart;
    }
    return total;
  }

  /** 获取总经过时间（毫秒） */
  getTotalElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** 是否执行超时 */
  isExecutionTimeout(): boolean {
    if (this.totalTimeoutMs <= 0 || !Number.isFinite(this.totalTimeoutMs)) return false;
    return this.getActiveExecutionMs() >= this.totalTimeoutMs;
  }

  /** 是否用户等待超时 */
  isUserWaitTimeout(): boolean {
    return this.getUserWaitMs() >= this.userWaitTimeoutMs;
  }

  /** 剩余执行时间（毫秒） */
  remainingExecutionMs(): number {
    if (this.totalTimeoutMs <= 0 || !Number.isFinite(this.totalTimeoutMs)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.totalTimeoutMs - this.getActiveExecutionMs());
  }
}
