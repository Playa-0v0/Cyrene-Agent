/**
 * exactly-once settlement gate 单元测试。
 *
 * 验收不变量：
 * - trySettle 第一次返回 true，第二次返回 false（exactly-once）。
 * - get() 始终返回第一次的 settlement，不受后续 trySettle 影响。
 * - success / cancelled / timeout / runtime_error 四态都能被记账。
 * - externalEffectsMayContinue 是必填 invariant。
 *
 * 本文件只测纯状态 gate，不测 bridge 集成（bridge 集成测试在 agui-bridge.test.ts）。
 */

import { describe, expect, it } from "vitest";
import { RunSettlementGate } from "./run-settlement";
import type { CyreneRunTerminalResult } from "../../shared/run-terminal";

describe("RunSettlementGate", () => {
  it("returns true on first trySettle and false on subsequent calls", () => {
    const gate = new RunSettlementGate();
    const first: CyreneRunTerminalResult = {
      status: "success",
      externalEffectsMayContinue: false,
    };

    expect(gate.trySettle(first)).toBe(true);
    expect(
      gate.trySettle({ status: "runtime_error", reason: "E_MODEL_REQUEST_FAILED", externalEffectsMayContinue: true }),
    ).toBe(false);
    expect(
      gate.trySettle({ status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true }),
    ).toBe(false);
  });

  it("retains the first settlement regardless of later trySettle calls", () => {
    const gate = new RunSettlementGate();
    const first: CyreneRunTerminalResult = {
      status: "cancelled",
      reason: "user_cancelled",
      externalEffectsMayContinue: true,
    };

    gate.trySettle(first);
    gate.trySettle({ status: "success", externalEffectsMayContinue: false });
    gate.trySettle({
      status: "runtime_error",
      reason: "E_AGENT_GRAPH_TIMEOUT",
      externalEffectsMayContinue: true,
    });

    expect(gate.get()).toStrictEqual(first);
  });

  it("returns null from get() before any trySettle", () => {
    const gate = new RunSettlementGate();
    expect(gate.get()).toBeNull();
  });

  it("records all four terminal statuses correctly", () => {
    for (const settlement of [
      { status: "success", externalEffectsMayContinue: false } as const,
      { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true } as const,
      { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true } as const,
      { status: "runtime_error", reason: "E_MODEL_REQUEST_FAILED", externalEffectsMayContinue: true } as const,
    ]) {
      const gate = new RunSettlementGate();
      expect(gate.trySettle(settlement)).toBe(true);
      expect(gate.get()).toStrictEqual(settlement);
    }
  });

  it("isSettled() flips to true after the first trySettle", () => {
    const gate = new RunSettlementGate();
    expect(gate.isSettled()).toBe(false);
    gate.trySettle({ status: "success", externalEffectsMayContinue: false });
    expect(gate.isSettled()).toBe(true);
    gate.trySettle({ status: "runtime_error", externalEffectsMayContinue: true });
    expect(gate.isSettled()).toBe(true);
  });
});
