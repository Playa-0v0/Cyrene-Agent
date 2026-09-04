import { useTranslation } from "../../i18n";

interface WindowControlsProps {
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
}

export function WindowControls({ onMinimize, onMaximize, onClose }: WindowControlsProps) {
  const { t } = useTranslation();
  return (
    <div className="cy-window-controls">
      <button type="button" className="cy-winbtn cy-winbtn--minimize" onClick={onMinimize} aria-label={t("ui.minimize")}>
        <svg width="10" height="2" viewBox="0 0 10 2" aria-hidden="true">
          <rect width="10" height="2" rx="1" fill="currentColor" />
        </svg>
      </button>
      <button type="button" className="cy-winbtn cy-winbtn--maximize" onClick={onMaximize} aria-label={t("ui.maximizeOrRestore")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" className="cy-winbtn cy-winbtn--close" onClick={onClose} aria-label={t("ui.closeChatWindow")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
