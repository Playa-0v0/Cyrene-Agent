// RightInspector — 统一的右侧挤出式面板容器。
// 把 diff 审查与计划清单合并到同一面板，顶部 tab 切换（像浏览器标签页），
// 任一存在即挤出白色工作区；只有一个 tab 时退化成单面板（不显示 tab 栏）。
//
// 设计依据：ReviewInspector 的挤出式 aside 布局，扩展为多 tab。

import type { ReactNode } from "react";
import "./RightInspector.css";

export interface InspectorTab {
  id: string;
  label: string;
  /** 阶段色点 class（如 is-review / is-executing / is-completed），不传则不显示 */
  dotClass?: string;
  content: ReactNode;
}

export function RightInspector({
  tabs,
  activeTabId,
  onTabChange,
  onClose,
}: {
  tabs: InspectorTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  onClose: () => void;
}) {
  if (tabs.length === 0) return null;
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const showTabs = tabs.length > 1;
  return (
    <aside className="cy-right-inspector" aria-label="右侧检查面板">
      <div className="cy-right-inspector__header">
        {showTabs ? (
          <div className="cy-right-inspector__tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === active.id}
                className={`cy-right-inspector__tab ${tab.id === active.id ? "is-active" : ""}`}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.dotClass && (
                  <span className={`cy-right-inspector__dot ${tab.dotClass}`} aria-hidden="true" />
                )}
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="cy-right-inspector__single-title">
            {tabs[0].dotClass && (
              <span className={`cy-right-inspector__dot ${tabs[0].dotClass}`} aria-hidden="true" />
            )}
            {tabs[0].label}
          </div>
        )}
        <button type="button" className="cy-right-inspector__close" onClick={onClose} aria-label="关闭">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
      </div>
      <div className="cy-right-inspector__body">{active.content}</div>
    </aside>
  );
}
