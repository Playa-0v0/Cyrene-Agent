import skillIconUrl from "../../assets/status-moods/陪伴中.png?url";
import { useTranslation } from "../../i18n";

interface SkillModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function SkillModeButton({ active = false, onClick }: SkillModeButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      className={`cy-side-action ${active ? "is-active" : ""}`}
      onClick={onClick}
      type="button"
      title={t("ui.skills")}
      aria-pressed={active}
    >
      <span className="cy-side-action-icon">
        <img src={skillIconUrl} alt="" width="22" height="22" style={{ objectFit: "contain" }} />
      </span>
      <span className="cy-side-action-label">{t("ui.skills")}</span>
    </button>
  );
}
