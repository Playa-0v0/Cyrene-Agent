import { useTranslation } from "../../i18n";

interface CharacterStatusPillProps {
  avatarPath: string;
  name?: string;
  status?: string;
}

export function CharacterStatusPill({
  avatarPath,
  name = "Cyrene",
  status,
}: CharacterStatusPillProps) {
  const { t } = useTranslation();
  return (
    <div className="cy-status-pill">
      <img className="cy-status-avatar" src={avatarPath} alt="" />
      <span className="cy-status-name">{name}</span>
      <span className="cy-status-divider">·</span>
      <span className="cy-status-text">{status ?? t("ui.modelNotConnected")}</span>
    </div>
  );
}
