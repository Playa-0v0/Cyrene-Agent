import toolIconUrl from "../../assets/tools.png?url";
import { useTranslation } from "../../i18n";

interface ToolModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function ToolModeButton({ active = false, onClick }: ToolModeButtonProps) {
  const { t } = useTranslation();
  return <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={t("ui.tools")} aria-pressed={active}>
    <span className="cy-side-action-icon">
      <img src={toolIconUrl} alt="" width="18" height="18" style={{ objectFit: "contain" }} />
    </span>
    <span className="cy-side-action-label">{t("ui.tools")}</span>
  </button>;
}
