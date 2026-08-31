import { useMemo } from "react";
import type { TodoState } from "../../../../shared/todo-types";
import workTodoPngUrl from "../../../assets/status-moods/提醒.png?url";
import learnTodoPngUrl from "../../../assets/status-moods/学习.png?url";
import { useFloatingCard } from "./floating-card";
import "./TodoPanel.css";

export interface TodoPanelProps {
  state: TodoState | null;
  mode: "work" | "learn";
}

const DEFAULT_WIDTH = 240;

const MODE_LABELS: Record<TodoPanelProps["mode"], string> = {
  work: "工作",
  learn: "学习",
};

function EmptyCircleIcon() {
  return (
    <svg className="cy-todo__bullet" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="#FF5B8A" strokeWidth="2" />
    </svg>
  );
}

function CheckedCircleIcon() {
  return (
    <svg className="cy-todo__bullet" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#FF5B8A" />
      <path
        d="M7 12l3 3 5-6"
        stroke="#fff"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToggleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M27 9V21H39" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 39V27H9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M27 21L42 6" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 27L6 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ModeCapsule({ mode }: { mode: TodoPanelProps["mode"] }) {
  return (
    <div className="cy-todo__mode-capsule">
      <span className="cy-todo__mode-dot" aria-hidden="true" />
      <span className="cy-todo__mode-label">{MODE_LABELS[mode]}</span>
    </div>
  );
}

export function TodoPanel({ state, mode }: TodoPanelProps) {
  const floating = useFloatingCard({ width: DEFAULT_WIDTH });

  const todos = state?.todos ?? [];
  const total = todos.length;
  const completed = useMemo(() => todos.filter((t) => t.status === "completed").length, [todos]);
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div
      className={`cy-todo ${floating.collapsed ? "cy-todo--collapsed" : ""}`}
      style={{ left: floating.position.x, top: floating.position.y }}
      role="region"
      aria-label="当前任务"
    >
      <button
        type="button"
        className="cy-todo__dragbar"
        onMouseDown={floating.onHeaderMouseDown}
        onClick={floating.onHeaderClick}
        aria-expanded={!floating.collapsed}
        title="拖动"
      >
        <span className="cy-todo__dragline" />
        <span
          className="cy-todo__toggle"
          data-floating-toggle
          onClick={(e) => {
            e.stopPropagation();
            floating.toggle();
          }}
        >
          <ToggleIcon />
        </span>
      </button>

      <div className="cy-todo__body">
        <div className="cy-todo__capsule-row">
          <ModeCapsule mode={mode} />
        </div>

        <div className="cy-todo__hero">
          <img className="cy-todo__mascot" src={mode === "learn" ? learnTodoPngUrl : workTodoPngUrl} alt="提醒" />
          <div className="cy-todo__hero-text">
            <div className="cy-todo__hero-title">当前任务</div>
            <div className="cy-todo__hero-sub">
              {completed}/{total} 已完成
            </div>
          </div>
        </div>

        <div className="cy-todo__divider" />

        <ul className="cy-todo__list" data-testid="todo-list">
          {total === 0 ? (
            <li className="cy-todo__item cy-todo__item--empty">
              <span className="cy-todo__status" aria-hidden="true">
                <EmptyCircleIcon />
              </span>
              <span className="cy-todo__content">暂无任务</span>
            </li>
          ) : (
            todos.map((todo) => {
              const isCompleted = todo.status === "completed";
              return (
                <li
                  key={todo.id}
                  className={`cy-todo__item ${isCompleted ? "cy-todo__item--completed" : ""}`}
                >
                  <span className="cy-todo__status" aria-hidden="true">
                    {isCompleted ? <CheckedCircleIcon /> : <EmptyCircleIcon />}
                  </span>
                  <span className="cy-todo__content">{todo.content}</span>
                </li>
              );
            })
          )}
        </ul>

        <div className="cy-todo__footer" data-testid="todo-footer">
          <div className="cy-todo__divider" />

          <div
            className="cy-todo__progress"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="cy-todo__progress-bar" style={{ width: `${progress}%` }} />
            <span className="cy-todo__progress-text">{progress}%</span>
          </div>

          {mode === "work" && (
            <div className="cy-todo__extension-slot" data-testid="todo-extension-slot">
              <span className="cy-todo__extension-label">项目状态</span>
              <span className="cy-todo__extension-hint">Git 工作台即将接入</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
