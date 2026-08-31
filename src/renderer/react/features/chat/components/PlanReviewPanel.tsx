// PlanContent — 计划清单内容（由 RightInspector 容器承载）。
//
// 渲染复用聊天正文的 MarkdownContent（@ant-design/x-markdown + 代码高亮），
// 与模型回复的 md 渲染保持完全一致；阶段色点与提示由 RightInspector 顶部 tab 提供。
// 入口 chip（PlanReviewEntry）由 Code Todo 卡片承载，点击打开右侧面板。

import { MarkdownContent } from "./ChatMessageList";

export type PlanReviewPhase = "review" | "executing" | "completed";

const PHASE_NOTE: Record<PlanReviewPhase, string> = {
  review: "请审阅计划内容后在对话中的卡片里决定",
  executing: "已批准，昔涟正在按清单施工",
  completed: "本计划施工已完成",
};

const PHASE_DOT: Record<PlanReviewPhase, string> = {
  review: "is-review",
  executing: "is-executing",
  completed: "is-completed",
};

const PHASE_LABEL: Record<PlanReviewPhase, string> = {
  review: "计划 · 待审批",
  executing: "计划 · 执行中",
  completed: "计划 · 已完成",
};

export function PlanContent({
  content,
  phase = "review",
}: {
  content: string;
  phase?: PlanReviewPhase;
}) {
  return (
    <div className="cy-plan-content">
      <p className="cy-plan-content__note">{PHASE_NOTE[phase]}</p>
      <div className="cy-plan-content__body">
        <MarkdownContent content={content} />
      </div>
    </div>
  );
}

export function planTabLabel(phase: PlanReviewPhase): string {
  return PHASE_LABEL[phase];
}

export function planTabDotClass(phase: PlanReviewPhase): string {
  return PHASE_DOT[phase];
}

/** Code Todo 卡片底部的小入口按钮：点击打开右侧计划面板。 */
export function PlanReviewEntry({
  phase,
  onOpen,
}: {
  phase: PlanReviewPhase;
  onOpen: () => void;
}) {
  const labels: Record<PlanReviewPhase, string> = {
    review: "计划待审批",
    executing: "计划执行中",
    completed: "计划已完成",
  };
  return (
    <button type="button" className={`cy-plan-entry is-${phase}`} onClick={onOpen}>
      <span className={`cy-plan-entry__dot ${PHASE_DOT[phase]}`} aria-hidden="true" />
      {labels[phase]} · 点击查看
    </button>
  );
}
