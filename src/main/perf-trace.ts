// Agent 回复性能追踪：在关键阶段记录耗时，帮助定位"回复慢"的瓶颈。
//
// 设计：
//   - 模块级单例，一次只追踪一个 turn（agent 回复通常串行，并发时自动 dump 旧 turn）。
//   - 日志前缀 [Perf]，终端 grep "[Perf]" 即可看到完整链路。
//   - 三种 API：
//       perf.track("name", async () => ...)  -- 异步追踪（推荐，自动管 begin/end）
//       const t = perf.begin("name"); ...; t.end()  -- 手动追踪
//       perf.mark("checkpoint")  -- 仅标记时间点
//   - turn 结束时 perf.dump() 打印汇总表（含每阶段耗时 + 占比）。
//
// 用法示例：
//   perf.beginTurn("desktop");
//   const ctx = await perf.track("always_on_context", () => buildAlwaysOnContext(...));
//   const t = perf.begin("cita_prepare"); ...; t.end();
//   perf.dump();  // 在 complete 回调或 finally 中调用

import { debugLog, debugWarn } from "./agent-log";

const PREFIX = "[Perf]";

interface PhaseMark {
  name: string;
  start: number;
  end?: number;
}

let turnStart = 0;
let turnLabel = "";
let phases: PhaseMark[] = [];

function now(): number {
  return Date.now();
}

function tPlus(): number {
  return turnStart > 0 ? now() - turnStart : 0;
}

export const perf = {
  /** 开始追踪一个 turn。如果上一个 turn 未 dump，自动先 dump。 */
  beginTurn(label = ""): void {
    if (turnStart > 0) {
      debugWarn(`${PREFIX} previous turn "${turnLabel}" not dumped, auto-dumping before new turn`);
      this.dump();
    }
    turnStart = now();
    turnLabel = label;
    phases = [];
    debugLog(`${PREFIX} ===== TURN START${label ? ` (${label})` : ""} =====`);
  },

  /**
   * 开始一个阶段的计时。返回 { end } 用于结束计时。
   * 嵌套使用时建议用 perf.track() 避免忘记 end。
   */
  begin(name: string): { end: (extra?: string) => void } {
    const start = now();
    const t0 = start - turnStart;
    debugLog(`${PREFIX} >>> ${name} t+${t0}ms`);
    return {
      end(extra) {
        const endTime = now();
        const elapsed = endTime - start;
        const t1 = endTime - turnStart;
        phases.push({ name, start, end: endTime });
        debugLog(`${PREFIX} <<< ${name} elapsed=${elapsed}ms t+${t1}ms${extra ? ` ${extra}` : ""}`);
      },
    };
  },

  /** 异步追踪一个阶段，自动管 begin/end。 */
  async track<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const timer = this.begin(name);
    try {
      return await fn();
    } finally {
      timer.end();
    }
  },

  /** 标记一个时间点（不计时，仅记录）。 */
  mark(name: string): void {
    debugLog(`${PREFIX} --- ${name} t+${tPlus()}ms`);
  },

  /** 打印汇总表并重置。在 turn 结束时调用。 */
  dump(): void {
    if (turnStart === 0) return;
    const total = now() - turnStart;
    debugLog(`${PREFIX} ===== TURN SUMMARY (total=${total}ms) =====`);
    if (phases.length === 0) {
      debugLog(`${PREFIX}   (no phases recorded)`);
    } else {
      for (const p of phases) {
        const elapsed = (p.end ?? now()) - p.start;
        const pct = total > 0 ? ((elapsed / total) * 100).toFixed(1) : "0.0";
        debugLog(`${PREFIX}   ${p.name.padEnd(48)} ${String(elapsed).padStart(6)}ms  (${pct}%)`);
      }
    }
    debugLog(`${PREFIX} ===== END SUMMARY =====`);
    turnStart = 0;
    phases = [];
    turnLabel = "";
  },
};
