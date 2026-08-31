/**
 * Harness 工具执行轮
 * 注：注释中的 "v3 §x" / "设计稿 §x" 均指 docs/design/2026-08-08-cyreneHarnessloopdesign.md（CyreneHarness 设计稿 v3）。
 *
 * 职责：模型发起 tool call 后的一轮执行——
 * - ask_user / confirm_uncertain_effect 排他分支（v3 §9.2）
 * - 普通工具的调度、执行、重试与按序提交
 * - uncertainEffects 记录与 fatal/unknown 中断判定
 *
 * 通过 HarnessRun 上下文读写运行状态；
 * 对 cyrene-harness.ts 只有 type-only import（编译后消失，无运行时循环依赖）。
 */

import type { ChatMessage, ToolCall } from "../vendors/types";
import type { ToolCallResult } from "../types";
import type { ToolObservation } from "./types";
import { parseToolCallArgs, toolCallFingerprint } from "./types";
import { dispatchToolCall, persistToolDispatchResult, type ToolDispatchResult } from "./tool-dispatcher";
import { classifyToolExecutionMode, scheduleToolCalls, type ToolCallScheduleResult, type ToolScheduleCommitDecision } from "./tool-call-scheduler";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tool-evidence";
import { classifyToolResultError } from "./error-classifier";
import { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";
import { isCancellationError, raceWithSignal } from "../../abort-utils";
import type { HarnessRun } from "./cyrene-harness";

/** 工具轮结果：completed = 结果已全部写回，继续下一轮；cancelled = 用户取消。 */
export type ToolRoundOutcome = "completed" | "cancelled";

/**
 * 执行一轮工具调用（v3 §3.1 / §9.2）。
 *
 * - ask_user / confirm_uncertain_effect 与其他工具互斥（v3 §9.2）：
 *   只执行首个 ask，其余调用统一返回 not_executed，等模型重新决策；
 * - 普通工具交给调度器：安全读操作滚动并行，独占调用前后形成串行屏障，
 *   模型可见结果始终按原始 tool-call 顺序写回。
 */
export async function runToolRound(run: HarnessRun, toolCalls: ToolCall[]): Promise<ToolRoundOutcome> {
  const { input } = run;
  const exclusiveToolNames = input.includeInteractiveTools === false
    ? new Set<string>()
    : new Set(["ask_user", "confirm_uncertain_effect"]);
  const askCalls = toolCalls.filter((c) => exclusiveToolNames.has(c.name));
  const otherCalls = toolCalls.filter((c) => !exclusiveToolNames.has(c.name));

  // ── ask_user 排他分支 ──
  if (askCalls.length > 0) {
    try {
      await runAskUserRound(run, askCalls, otherCalls);
    } catch (error) {
      // ask_user 等待期间 abort → cancelled
      if (isCancellationError(error, input.signal)) return "cancelled";
      throw error;
    }
    // ask_user 后丢弃 progress buffer，等待模型重新决策
    run.streamController.discardProgressBuffer();
    return "completed";
  }

  // ── 普通工具循环 ──
  // flush buffered content 为 progress message
  const progressContent = run.streamController.flushProgressBufferAsProgress();
  if (progressContent) {
    input.onEvent?.({ type: "progress_text", content: progressContent });
  }

  let schedule: ToolCallScheduleResult;
  try {
    schedule = await scheduleToolCalls({
      calls: otherCalls,
      maxParallel: run.config.maxParallelToolCalls,
      signal: input.signal,
      classify: (call) => classifyToolExecutionMode(call, input.tools),
      execute: ({ call }) => executeToolCallWithRetry(run, call),
      commit: ({ call }, result) => commitToolResult(run, call, result),
      notExecuted: async ({ call }, reason): Promise<ToolDispatchResult> =>
        reason === "execution_error"
          ? {
              // execute 抛错（基础设施故障）：合成失败结果保证 transcript 闭合（v3 §5.5），
              // fatal 类别让模型看到诚实结果后自行决策。
              outcome: "failure",
              category: "fatal",
              tool: call.name,
              message: "工具执行异常，结果不可用（execution error）",
            }
          : {
              outcome: "not_executed",
              category: "runtime_safety",
              tool: call.name,
              message: reason,
            },
    });
  } catch (error) {
    if (isCancellationError(error, input.signal)) return "cancelled";
    throw error;
  }
  if (schedule.cancelled || input.signal?.aborted) return "cancelled";
  return "completed";
}

/**
 * ask_user 排他轮（v3 §9.2）：
 * 只执行首个 ask_user，其余 ask 与同轮普通工具调用统一返回 not_executed。
 */
async function runAskUserRound(
  run: HarnessRun,
  askCalls: ToolCall[],
  otherCalls: ToolCall[],
): Promise<void> {
  const { input } = run;
  const primaryAsk = askCalls[0];

  // 其余 ask_user 返回 not_executed
  for (const call of askCalls.slice(1)) {
    input.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect: "read_only", status: "not_executed" });
    run.messages.push(toolResultMessage(call, {
      outcome: "not_executed",
      reason: "not_executed_due_to_another_ask",
    }));
  }

  // 同轮普通工具调用返回 not_executed
  for (const call of otherCalls) {
    input.onToolLifecycle?.({
      toolCallId: call.id,
      toolName: call.name,
      toolSideEffect: resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call)),
      status: "not_executed",
    });
    run.messages.push(toolResultMessage(call, {
      outcome: "not_executed",
      reason: "not_executed_due_to_clarification",
    }));
  }

  // 执行 ask_user（等待期间不计入执行超时）
  run.clock.startUserWait();
  input.onToolLifecycle?.({ toolCallId: primaryAsk.id, toolName: primaryAsk.name, toolSideEffect: "read_only", status: "started" });
  let askResult: ToolDispatchResult;
  try {
    askResult = await raceWithSignal(
      dispatchToolCall(primaryAsk, run.askDispatchContext),
      input.signal,
    );
  } catch (error) {
    run.clock.stopUserWait();
    throw error;
  }
  run.clock.stopUserWait();

  run.messages.push(toolResultMessage(primaryAsk, askResult));
  input.onToolLifecycle?.({
    toolCallId: primaryAsk.id,
    toolName: primaryAsk.name,
    toolSideEffect: "read_only",
    status: askResult.outcome === "unknown" ? "unknown" : askResult.outcome === "not_executed" ? "not_executed" : "committed",
  });
}

/**
 * 一次 logical invocation 的执行与重试，可在安全池内与其他调用重叠。
 * 输出持久化延后到重试收敛后的最终结果，确保一次调用只对应一条记录。
 */
async function executeToolCallWithRetry(run: HarnessRun, call: ToolCall): Promise<ToolDispatchResult> {
  const { input } = run;
  const toolSideEffect = resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));
  input.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect, status: "started" });

  let result = await raceWithSignal(dispatchToolCall(call, run.toolDispatchContext), input.signal);
  if (result.outcome === "failure") {
    const category = result.category ?? classifyToolResultError(
      result.rawResult ?? { toolId: call.name, args: {}, output: "", status: "failed" } as ToolCallResult,
    );
    if (decideRetry(category, toolSideEffect) === "retry") {
      const retryParams = getRetryParams(category);
      for (let attempt = 0; attempt < retryParams.maxRetries; attempt++) {
        await sleepWithJitter(retryParams.backoffMs[attempt] ?? 1000, input.signal);
        result = await raceWithSignal(dispatchToolCall(call, run.toolDispatchContext), input.signal);
        if (result.outcome !== "failure") break;
      }
    }
  }
  return persistToolDispatchResult(call, result, run.toolDispatchContext);
}

/**
 * 按原始 tool-call 顺序提交模型可见结果。
 * unknown + 非幂等副作用 → 记入 uncertainEffects 并 halt（v3 §5.5.1.1）；
 * fatal 错误 → halt；其余 → continue。
 */
async function commitToolResult(
  run: HarnessRun,
  call: ToolCall,
  result: ToolDispatchResult,
): Promise<ToolScheduleCommitDecision> {
  const { input } = run;
  const toolSideEffect = result.toolSideEffect
    ?? resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));
  if (result.toolOutputRef && !run.toolOutputs.some((entry) => entry.recordId === result.toolOutputRef?.recordId)) {
    run.toolOutputs.push(result.toolOutputRef);
  }
  input.onEvent?.({
    type: "tool_end",
    toolCallId: call.id,
    outcome: result.outcome,
    preview: (result.preview ?? result.message).slice(0, 200),
    // Diff Review 卡片证据走独立字段，不受 preview 截断影响
    changes: extractFileChangesFromOutput(result.output),
  });
  run.messages.push(toolResultMessage(call, result));
  input.onToolLifecycle?.({
    toolCallId: call.id,
    toolName: call.name,
    toolSideEffect,
    status: result.outcome === "unknown"
      ? "unknown"
      : result.outcome === "not_executed" ? "not_executed" : "committed",
  });

  if (result.outcome === "unknown" && toolSideEffect === "non_idempotent_side_effect") {
    const fingerprint = toolCallFingerprint(call.name, parseToolCallArgs(call));
    const effectId = `${input.toolContext?.runId ?? "unknown-run"}:${call.id}`;
    if (!run.state.uncertainEffects.some((effect) => effect.id === effectId)) {
      run.state.uncertainEffects.push({
        id: effectId,
        toolCallId: call.id,
        fingerprint,
        toolName: call.name,
        message: "副作用已发起，但 Runtime 无法确认是否生效",
      });
    }
    return "halt";
  }
  return result.category === "fatal" ? "halt" : "continue";
}

// ── 内部工具 ─────────────────────────────────────────────

/**
 * 构造模型可见的 tool result 消息。
 * 未截断的内置工具输出（例如 ask_user 的答案）仍是下一轮决策所需事实；
 * 长工具输出则必须只写入剪枝后的 preview，不能绕过截断再次注入模型上下文。
 */
function toolResultMessage(
  call: ToolCall,
  observation: ToolObservation | { outcome: string; reason: string },
): ChatMessage {
  const modelObservation = { ...observation } as Record<string, unknown>;
  if (modelObservation.truncated === true) {
    modelObservation.output = modelObservation.preview ?? modelObservation.message;
  }
  delete modelObservation.rawResult;
  delete modelObservation.toolOutputRef;
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(modelObservation),
  };
}
