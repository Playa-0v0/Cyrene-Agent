interface NewTaskButtonProps {
  label?: string;
  onClick?: () => void;
}

export function NewTaskButton({ label = "新建", onClick }: NewTaskButtonProps) {
  return (
    <button className="cy-side-action" onClick={onClick} type="button">
      <span className="cy-side-action-icon">
        <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
          <path
            d="M24 4C34 4 43 12 43 22C43 31 35.5 39.5 25 39.5C22.5 39.5 20.5 39 18.5 38L9.5 44L11.5 34C7.5 31 5 27 5 22C5 12 14 4 24 4Z"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M24 16V28" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          <path d="M18 22H30" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </span>
      <span className="cy-side-action-label">{label}</span>
    </button>
  );
}
