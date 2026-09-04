import { useUserAvatar } from "../../hooks/useUserAvatar";
import { useUserNickname } from "../../hooks/useUserNickname";
import { useTranslation } from "../../i18n";

interface UserAvatarProps {
  label?: string;
}

export function UserAvatar({ label }: UserAvatarProps) {
  const { t } = useTranslation();
  const avatarUrl = useUserAvatar();
  const nickname = useUserNickname();
  const displayLabel = (label ?? nickname) || "User";

  return (
    <div className="cy-user-avatar">
      <div className="cy-user-avatar-circle">
        {avatarUrl
          ? <img src={avatarUrl} alt={t("ui.userAlt")} draggable={false} />
          : <span>U</span>}
      </div>
      <span className="cy-user-avatar-label">{displayLabel}</span>
    </div>
  );
}
