import React from "react";
import { useTranslation } from "../../../i18n";
import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import { getCharacterPortraitByAssetFileName } from "../../../character-portraits";
import "./RunExperience.css";

// 状态标记符号（非文案）与 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const STATUS_MARKERS: Record<TaskDelegationDisplayRecord["status"], string> = {
  running: "◌",
  completed: "✓",
  failed: "×",
  cancelled: "×",
};

const STATUS_TEXT_KEYS: Record<TaskDelegationDisplayRecord["status"], string> = {
  running: "taskDelegation.statusRunning",
  completed: "taskDelegation.statusCompleted",
  failed: "taskDelegation.statusFailed",
  cancelled: "taskDelegation.statusCancelled",
};

export function TaskDelegationRow({ delegation }: { delegation: TaskDelegationDisplayRecord }) {
  const { t } = useTranslation();
  const portraitUrl = getCharacterPortraitByAssetFileName(delegation.assetFileName);
  return (
    <div className={`cy-task-delegation is-${delegation.status}`}>
      <span className="cy-task-delegation__marker" aria-hidden="true">{STATUS_MARKERS[delegation.status]}</span>
      <span className="cy-task-delegation__lead">{t("taskDelegation.delegatedTo")}</span>
      {portraitUrl && <img className="cy-task-delegation__avatar" src={portraitUrl} alt={delegation.nickname} draggable={false} />}
      <span className="cy-task-delegation__nickname">{delegation.nickname}</span>
      <span className="cy-task-delegation__description">{delegation.description}</span>
      <span className="cy-task-delegation__status">{t(STATUS_TEXT_KEYS[delegation.status])}</span>
    </div>
  );
}
