import { useState } from "react";
import { useTranslation } from "../../i18n";

interface SidebarToggleProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export function SidebarToggle({ collapsed: controlledCollapsed, onToggle }: SidebarToggleProps) {
  const { t } = useTranslation();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;

  const handleClick = () => {
    setInternalCollapsed((v) => !v);
    onToggle?.();
  };

  return (
    <button
      className={`cy-sidebar-toggle ${collapsed ? "is-collapsed" : ""} ${hovered ? "is-hovered" : ""}`}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={t("ui.toggleSidebar")}
    >
      <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
        {/* 框 - 不变 */}
        <rect x="6" y="6" width="36" height="36" rx="3" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" />

        {/* 竖线 */}
        <path
          className="cy-sidebar-line"
          d="M24 6V42"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* 上横线 */}
        <path d="M11 6H36" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* 下横线 */}
        <path d="M11 42H36" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Chevron */}
        <path
          className="cy-sidebar-chevron"
          d="M32 20L28 24L32 28"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
