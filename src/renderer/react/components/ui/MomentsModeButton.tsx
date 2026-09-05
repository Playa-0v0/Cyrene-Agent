import React from "react";
import momentsIconUrl from "../../assets/moments.png?url";
import { useTranslation } from "../../i18n";

interface MomentsModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function MomentsModeButton({ active = false, onClick }: MomentsModeButtonProps) {
  const { t } = useTranslation();
  return <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={t("ui.moments")} aria-pressed={active}>
    <span className="cy-side-action-icon">
      <img src={momentsIconUrl} alt="" width="22" height="22" style={{ objectFit: "contain" }} />
    </span>
    <span className="cy-side-action-label">{t("ui.moments")}</span>
  </button>;
}
