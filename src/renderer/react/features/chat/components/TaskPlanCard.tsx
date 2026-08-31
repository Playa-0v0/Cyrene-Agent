import type { TaskPlanPresentation } from "./run-presentation";
import "./RunExperience.css";

const STATUS_LABEL = {
  pending: "待执行",
  running: "进行中",
  completed: "已完成",
  failed: "未完成",
} as const;

export function TaskPlanCard({ plan }: { plan: TaskPlanPresentation }) {
  return (
    <section className="cy-task-plan-card" aria-label="任务计划">
      <header>
        <span>任务计划</span>
        {plan.title && <strong>{plan.title}</strong>}
      </header>
      <ol>
        {plan.steps.map((step) => {
          const status = step.status ?? "pending";
          return (
            <li key={step.id} className={`is-${status}`}>
              <span className="cy-task-plan-card__marker" aria-hidden="true" />
              <span>{step.title}</span>
              <small>{STATUS_LABEL[status]}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
