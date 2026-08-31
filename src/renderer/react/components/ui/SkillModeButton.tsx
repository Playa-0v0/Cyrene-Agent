interface SkillModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function SkillModeButton({ active = false, onClick }: SkillModeButtonProps) {
  return (
    <button
      className={`cy-side-action ${active ? "is-active" : ""}`}
      onClick={onClick}
      type="button"
      title="技能"
      aria-pressed={active}
    >
      <span className="cy-side-action-icon">
        <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
          <path d="M39 6H9C7.34315 6 6 7.34315 6 9V39C6 40.6569 7.34315 42 9 42H39C40.6569 42 42 40.6569 42 39V9C42 7.34315 40.6569 6 39 6Z" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M21 31L26 35L34 25" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 15H34" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 23L22 23" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="cy-side-action-label">技能</span>
    </button>
  );
}
