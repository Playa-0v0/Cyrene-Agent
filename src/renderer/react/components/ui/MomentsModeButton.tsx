import React from "react";
import { useTranslation } from "../../i18n";

interface MomentsModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function MomentsModeButton({ active = false, onClick }: MomentsModeButtonProps) {
  const { t } = useTranslation();
  return <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={t("ui.moments")} aria-pressed={active}>
    <span className="cy-side-action-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 20.5s-7.2-4.5-9.1-8.7C1.4 8.6 3.3 5.3 6.7 5.3c2 0 3.6 1.1 4.4 2.7.4.8 1.4.8 1.8 0 .8-1.6 2.4-2.7 4.4-2.7 3.4 0 5.3 3.3 3.8 6.5-1.9 4.2-9.1 8.7-9.1 8.7Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </span>
    <span className="cy-side-action-label">{t("ui.moments")}</span>
  </button>;
}
