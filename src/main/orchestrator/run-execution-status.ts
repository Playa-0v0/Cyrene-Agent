/**
 * 运行时执行状态 —— 独立模块，避免 cyrene-agent ↔ langgraph-agent-loop 循环依赖。
 *
 * 职责：
 * - 定义 RunPhase、SuccessfulToolExecution、CreatedArtifact、RunExecutionStatus
 * - 提供 snapshotRunExecutionStatus 不可变快照
 * - 定义 AgentExecutionError（携带 executionStatus + 原始 cause）
 */

// ── Phase 类型 ─────────────────────────────

/** 执行阶段（统一定义，旧节点名做映射） */
export type RunPhase =
  | "context"
  | "cita"
  | "router"
  | "create_plan"
  | "action_gate"
  | "native_fc"
  | "tool_execute"
  | "plan_verify"
  | "plan_replan"
  | "soul"
  | "unknown";

// ── 安全精简的工具执行记录 ──────────────────

/** 成功工具的安全摘要（不包含完整 output） */
export interface SuccessfulToolExecution {
  capabilityId: string;
  actionLabel: string;
  completionClaims: string[];
}

/** 可信文件产物 */
export interface CreatedArtifact {
  path: string;
  kind?: "docx" | "pdf" | "xlsx" | "markdown" | "file";
  capabilityId: string;
}

// ── 执行状态 ──────────────────────────────

export interface RunExecutionStatus {
  phase: RunPhase;
  successfulTools: SuccessfulToolExecution[];
  createdArtifacts: CreatedArtifact[];
  /**
   * 整体任务是否已确认完成。
   * 唯一来源：
   *   - taskPlan?.status === "completed"
   *   - directExecutionCompletionConfirmed === true（Action Gate 路由到 respond + 所有 completion evidence 满足）
   * 不能由 createdArtifacts、工具成功数量或进入 Soul 推断。
   */
  taskCompletionConfirmed: boolean;
}

/** 创建不可变快照（防止后续变化污染错误对象） */
export function snapshotRunExecutionStatus(status: RunExecutionStatus): RunExecutionStatus {
  return {
    phase: status.phase,
    successfulTools: status.successfulTools.map((t) => ({
      capabilityId: t.capabilityId,
      actionLabel: t.actionLabel,
      completionClaims: [...t.completionClaims],
    })),
    createdArtifacts: status.createdArtifacts.map((a) => ({ ...a })),
    taskCompletionConfirmed: status.taskCompletionConfirmed,
  };
}

// ── 错误类型 ──────────────────────────────

/** 携带执行状态的错误（保留原始 cause） */
export class AgentExecutionError extends Error {
  constructor(
    message: string,
    readonly executionStatus: RunExecutionStatus,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentExecutionError";
  }
}
