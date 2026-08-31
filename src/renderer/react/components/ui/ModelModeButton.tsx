import modelIconUrl from "../../assets/status-moods/陪伴中.png?url";

interface ModelModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function ModelModeButton({ active = false, onClick }: ModelModeButtonProps) {
  return <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title="模型" aria-pressed={active}>
    <span className="cy-side-action-icon">
      <img src={modelIconUrl} alt="" width="18" height="18" style={{ objectFit: "contain" }} />
    </span>
    <span className="cy-side-action-label">模型</span>
  </button>;
}
