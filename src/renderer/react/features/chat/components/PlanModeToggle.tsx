// 计划模式 on/off 开关 —— 走 Popover + Segmented 风格，参考 ReasoningControl
// 触发按钮 label：计划模式 · on / 计划模式 · off
// 状态来源：挂载时 getPlanState 拿初始状态；之后订阅 onPlanStateChanged 自动同步
// 任意入口（用户切换 / 模型 enter_plan_mode / 审批 / 执行完成）的状态变化都会同步

import { Popover, Segmented } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import reminderIconUrl from "../../../assets/status-moods/提醒.png?url";
import "./PlanModeToggle.css";

interface PlanApi {
  setPlanMode?: (payload: { conversationId: string; target: "on" | "off"; workspaceRoot?: string }) => Promise<{ ok: boolean; state?: string; reason?: string }>;
  getPlanState?: (conversationId: string) => Promise<{ state: string }>;
  onPlanStateChanged?: (
    callback: (payload: { conversationId: string; state: string }) => void,
  ) => (() => void) | void;
}

interface PlanModeToggleProps {
  conversationId: string;
  workspaceRoot?: string;
}

function planApi(): PlanApi | undefined {
  return (window as typeof window & { settings?: PlanApi }).settings;
}

function isPlanActive(state: string | undefined): boolean {
  return state === "PLAN_DISCUSSING" || state === "PLAN_REVIEW" || state === "EXECUTING";
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

export function PlanModeToggle({ conversationId, workspaceRoot }: PlanModeToggleProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active0 = true;
    void planApi()?.getPlanState?.(conversationId).then((res) => {
      if (active0) setActive(isPlanActive(res.state));
    }).catch(() => { /* getPlanState 失败静默；订阅广播会兜底 */ });
    const unsubscribe = planApi()?.onPlanStateChanged?.((payload) => {
      if (payload.conversationId !== conversationId) return;
      setActive(isPlanActive(payload.state));
    });
    return () => {
      active0 = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [conversationId]);

  async function select(value: string | number) {
    const target = value === "on" ? "on" : "off";
    try {
      const result = await planApi()?.setPlanMode?.({ conversationId, target, workspaceRoot });
      if (result?.ok && result.state) {
        setActive(isPlanActive(result.state));
      } else if (!result?.ok && result?.reason) {
        console.warn("[PlanModeToggle] setPlanMode rejected:", result.reason);
      }
      setOpen(false);
    } catch (err) {
      console.warn("[PlanModeToggle] setPlanMode failed:", err);
    }
  }

  const label = t("planToggle.label", { state: active ? "on" : "off" });

  const panel = (
    <div className="cy-plan-panel">
      <strong>{t("planToggle.title")}</strong>
      <span>{t("planToggle.desc")}</span>
      <Segmented
        block
        size="small"
        value={active ? "on" : "off"}
        options={[
          { label: "on", value: "on" },
          { label: "off", value: "off" },
        ]}
        onChange={select}
      />
    </div>
  );

  return (
    <Popover
      content={panel}
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={setOpen}
      overlayClassName="cy-plan-popover"
    >
      <button type="button" className={`cy-composer__agent-button cy-plan-control ${active ? "is-active" : ""}`} aria-pressed={active}>
        <img className="cy-plan-icon" src={reminderIconUrl} alt="" />
        <span>{label}</span>
        <ChevronIcon />
      </button>
    </Popover>
  );
}
