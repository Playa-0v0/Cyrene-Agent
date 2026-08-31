interface CharacterStatusPillProps {
  avatarPath: string;
  name?: string;
  status?: string;
}

export function CharacterStatusPill({
  avatarPath,
  name = "Cyrene",
  status = "模型未连接",
}: CharacterStatusPillProps) {
  return (
    <div className="cy-status-pill">
      <img className="cy-status-avatar" src={avatarPath} alt="" />
      <span className="cy-status-name">{name}</span>
      <span className="cy-status-divider">·</span>
      <span className="cy-status-text">{status}</span>
    </div>
  );
}
