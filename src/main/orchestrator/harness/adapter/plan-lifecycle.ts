import * as fs from "fs";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { ReviewRunStatus } from "../../../../shared/review-types";
import {
  completeExecution,
  getPlanPath,
  getPlanState,
  supplementPlan,
} from "../../plan-mode";

const LOG_PREFIX = "[HarnessAdapter]";

/**
 * 计划模式生命周期（lifecycle）适配：只负责读取/推进计划状态和发送完成通知，
 * 不负责组装普通提示词，也不拥有计划状态本身（状态仍由 plan-mode 单例持有）。
 */
export async function preparePlanRunContext(input: {
  mode?: ConversationMode;
  threadId: string;
}): Promise<{
  planState: ReturnType<typeof getPlanState> | undefined;
  planContextBlock?: string;
}> {
  const participatesInPlanMode = input.mode === "code" || input.mode === "chat";
  if (participatesInPlanMode && getPlanState(input.threadId) === "PLAN_REVIEW") {
    // PLAN_REVIEW 收到新消息意味着用户继续讨论；先退回讨论态，再拍摄本次 run 的状态快照。
    supplementPlan(input.threadId);
    console.log(`${LOG_PREFIX} [Plan] new message during PLAN_REVIEW, back to PLAN_DISCUSSING`);
  }

  const planState = participatesInPlanMode ? getPlanState(input.threadId) : undefined;
  if (planState !== "EXECUTING") {
    return { planState };
  }

  try {
    // 读取磁盘是异步边界，必须在创建 run 快照前完成，避免快照缺少已批准计划。
    const planContent = await fs.promises.readFile(getPlanPath(input.threadId), "utf8");
    return {
      planState,
      planContextBlock: [
        "[PLAN_CONTEXT]",
        "用户已批准以下实施计划。请严格按计划清单顺序执行，用 update_todo 维护任务进度：",
        "",
        planContent.trim(),
      ].join("\n"),
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} [Plan] read plan.md failed:`, err instanceof Error ? err.message : err);
    return { planState };
  }
}

export function completePlanRun(input: {
  mode?: ConversationMode;
  threadId: string;
  runId: string;
  runStatus: ReviewRunStatus;
  signal: AbortSignal;
  send: (event: BaseEvent) => void;
}): void {
  if (input.mode !== "code" && input.mode !== "chat") return;

  const finishedPlanPath = completeExecution(input.threadId);
  if (!finishedPlanPath) return;

  console.log(`${LOG_PREFIX} [Plan] execution finished, back to NORMAL, plan=${finishedPlanPath}`);
  // completeExecution 对成功、失败、取消都要调用；只有真正完成执行态才发送前端通知。
  if (input.signal.aborted) return;

  input.send({
    type: EventType.CUSTOM,
    name: "cyrene.plan.completed",
    value: { planPath: finishedPlanPath, runStatus: input.runStatus },
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent);
}
