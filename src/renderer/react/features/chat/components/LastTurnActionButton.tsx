import { useTranslation } from "../../../i18n";

interface LastTurnActionButtonProps {
  kind: "edit" | "regenerate";
  disabled?: boolean;
  onClick: () => void;
}

export function LastTurnActionButton({ kind, disabled = false, onClick }: LastTurnActionButtonProps) {
  const { t } = useTranslation();
  const label = kind === "edit" ? t("lastTurn.editMessage") : t("lastTurn.regenerateReply");
  return (
    <button
      type="button"
      className={`cy-last-turn-action cy-last-turn-action--${kind}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {kind === "edit" ? (
        <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M7 41L16.5 38.5L39 16L32 9L9.5 31.5L7 41Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
          <path d="M27.5 13.5L34.5 20.5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      ) : (
        <svg className="cy-last-turn-action__regenerate-icon" width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M40 17A18 18 0 1 0 41 29" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          <path d="M40 7V17H30" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
