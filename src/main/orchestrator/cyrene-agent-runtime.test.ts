import { describe, expect, it } from "vitest";
import { firstValueFrom } from "rxjs";
import { resolveExecutionMode, CyreneAgent } from "./cyrene-agent";
import type { CyreneRunOptions } from "./cyrene-agent";
import type { BaseEvent } from "@ag-ui/core";

describe("resolveExecutionMode", () => {
  it("uses Work by default and migrates legacy execution mode names", () => {
    expect(resolveExecutionMode(undefined)).toBe("work");
    expect(resolveExecutionMode("work")).toBe("work");
    expect(resolveExecutionMode("chat")).toBe("chat");
    expect(resolveExecutionMode("collaboration")).toBe("work");
    expect(resolveExecutionMode("soul-only")).toBe("chat");
  });
});

// ── fallback runId 不污染调用方 options 对象 ──────────────────────

/**
 * 构造最小可用的 CyreneRunOptions。
 * provider="invalid" 会让 getAdapterForConfig 抛错，但 RUN_STARTED 在 adapter 调用之前发出，
 * 所以测试仍能捕获 runId。错误会被 CyreneAgent 的 catch 块吞掉走 subscriber.error()。
 */
function makeMinimalOptions(): CyreneRunOptions {
  return {
    settings: {
      provider: "invalid-provider",
      baseUrl: "",
      model: "",
      apiKey: "",
      contextWindowTokens: 4096,
    },
    messages: [{ role: "user", content: "hi" }],
    executionMode: "chat",
    timeoutMs: 1000,
    toolSystemContent: "",
    soulSystemBaseContent: "",
  };
}

/** 订阅 runWithEvents，取第一个事件（RUN_STARTED）的 runId。 */
async function captureRunStarted(options: CyreneRunOptions): Promise<{ runId: string }> {
  const agent = new CyreneAgent({ threadId: "test-thread" });
  // firstValueFrom 内部 subscribe + take(1)，避免手动引用 sub 的 TDZ 问题。
  // RUN_STARTED 是 runWithEvents 发出的第一个事件（在 adapter 调用之前），所以能安全拿到。
  const event = await firstValueFrom(agent.runWithEvents(options));
  const runId = (event as { runId?: string }).runId;
  if (!runId) throw new Error("RUN_STARTED did not carry runId");
  return { runId };
}

describe("CyreneAgent.runWithEvents runId handling", () => {
  it("does not write back fallback runId to the caller's options object", async () => {
    const options = makeMinimalOptions();
    expect(options.runId).toBeUndefined();

    const { runId } = await captureRunStarted(options);

    // 关键不变量：fallback runId 不能写回调用方对象
    expect(options.runId).toBeUndefined();
    // 但本轮 RUN_STARTED 必须有 runId
    expect(runId).toBeTruthy();
    expect(typeof runId).toBe("string");
  });

  it("produces two different runIds when the same options object is run twice", async () => {
    const options = makeMinimalOptions();

    const first = await captureRunStarted(options);
    const second = await captureRunStarted(options);

    // 同一未设 runId 的 options 跑两次，必须产生两个不同的 runId
    expect(first.runId).toBeTruthy();
    expect(second.runId).toBeTruthy();
    expect(first.runId).not.toBe(second.runId);
    // options 对象始终未被污染
    expect(options.runId).toBeUndefined();
  });

  it("preserves an explicitly-provided runId across the full event chain", async () => {
    const explicitRunId = "run-explicit-12345";
    const options: CyreneRunOptions = { ...makeMinimalOptions(), runId: explicitRunId };

    const { runId } = await captureRunStarted(options);

    // 显式传入的 runId 必须全链路保留
    expect(runId).toBe(explicitRunId);
    // options 对象的 runId 不被修改（仍是原值）
    expect(options.runId).toBe(explicitRunId);
  });
});
