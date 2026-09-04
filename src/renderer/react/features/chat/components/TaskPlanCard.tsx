import { useTranslation } from "../../../i18n";
import type { TaskPlanPresentation } from "./run-presentation";
import "./RunExperience.css";

type TaskPlanStepStatus = NonNullable<TaskPlanPresentation["steps"][number]["status"]>;

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const STATUS_LABEL_KEYS: Record<TaskPlanStepStatus, string> = {
  pending: "taskPlan.statusPending",
  running: "taskPlan.statusRunning",
  completed: "taskPlan.statusCompleted",
  failed: "taskPlan.statusFailed",
};

export function TaskPlanCard({ plan }: { plan: TaskPlanPresentation }) {
  const { t } = useTranslation();
  return (
    <section className="cy-task-plan-card" aria-label={t("taskPlan.panelAria")}>
      <header>
        <span>{t("taskPlan.title")}</span>
        {plan.title && <strong>{plan.title}</strong>}
      </header>
      <ol>
        {plan.steps.map((step) => {
          const status = step.status ?? "pending";
          return (
            <li key={step.id} className={`is-${status}`}>
              <span className="cy-task-plan-card__marker" aria-hidden="true" />
              <span>{step.title}</span>
              <small>{t(STATUS_LABEL_KEYS[status])}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
