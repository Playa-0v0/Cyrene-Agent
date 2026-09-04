import React from "react";
import { useTranslation } from "../../../i18n";
import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import "./RunExperience.css";
import fengjinUrl from "../../../../tast/风堇.png";
import klyUrl from "../../../../tast/刻律德菈.png";
import changyeyueUrl from "../../../../tast/长夜月.png";
import xiadiUrl from "../../../../tast/遐蝶.png";
import tibaoUrl from "../../../../tast/缇宝.png";
import aglaiyaUrl from "../../../../tast/阿格莱雅.png";
import baierUrl from "../../../../tast/白厄.png";
import danhengUrl from "../../../../tast/丹恒.png";
import hysUrl from "../../../../tast/海瑟音.png";
import nakexiaUrl from "../../../../tast/那刻夏.png";
import saifeierUrl from "../../../../tast/赛飞儿.png";
import wandiUrl from "../../../../tast/万敌.png";

const avatarUrls: Readonly<Record<string, string>> = {
  "风堇.png": fengjinUrl, "刻律德菈.png": klyUrl, "长夜月.png": changyeyueUrl, "遐蝶.png": xiadiUrl,
  "缇宝.png": tibaoUrl, "阿格莱雅.png": aglaiyaUrl, "白厄.png": baierUrl, "丹恒.png": danhengUrl,
  "海瑟音.png": hysUrl, "那刻夏.png": nakexiaUrl, "赛飞儿.png": saifeierUrl, "万敌.png": wandiUrl,
};

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
  return (
    <div className={`cy-task-delegation is-${delegation.status}`}>
      <span className="cy-task-delegation__marker" aria-hidden="true">{STATUS_MARKERS[delegation.status]}</span>
      <span className="cy-task-delegation__lead">{t("taskDelegation.delegatedTo")}</span>
      <img className="cy-task-delegation__avatar" src={avatarUrls[delegation.assetFileName]} alt={delegation.nickname} draggable={false} />
      <span className="cy-task-delegation__nickname">{delegation.nickname}</span>
      <span className="cy-task-delegation__description">{delegation.description}</span>
      <span className="cy-task-delegation__status">{t(STATUS_TEXT_KEYS[delegation.status])}</span>
    </div>
  );
}
