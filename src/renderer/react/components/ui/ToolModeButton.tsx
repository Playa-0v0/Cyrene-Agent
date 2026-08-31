interface ToolModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function ToolModeButton({ active = false, onClick }: ToolModeButtonProps) {
  return (
    <button
      className={`cy-side-action ${active ? "is-active" : ""}`}
      onClick={onClick}
      type="button"
      title="工具"
      aria-pressed={active}
    >
      <span className="cy-side-action-icon">
        <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
          <path
            d="M10 14C10 11.7909 11.7909 10 14 10H16.5C17.5 10 18.4 10.4 19.05 11.05L21.95 13.95C22.6 14.6 23.5 15 24.5 15H27.5C28.5 15 29.4 14.6 30.05 13.95L32.95 11.05C33.6 10.4 34.5 10 35.5 10H38C40.2091 10 42 11.7909 42 14V16.5C42 17.5 41.6 18.4 40.95 19.05L38.05 21.95C37.4 22.6 37 23.5 37 24.5V27.5C37 28.5 37.4 29.4 38.05 30.05L40.95 32.95C41.6 33.6 42 34.5 42 35.5V38C42 40.2091 40.2091 42 38 42H35.5C34.5 42 33.6 41.6 32.95 40.95L30.05 38.05C29.4 37.4 28.5 37 27.5 37H24.5C23.5 37 22.6 37.4 21.95 38.05L19.05 40.95C18.4 41.6 17.5 42 16.5 42H14C11.7909 42 10 40.2091 10 38V35.5C10 34.5 10.4 33.6 11.05 32.95L13.95 30.05C14.6 29.4 15 28.5 15 27.5V24.5C15 23.5 14.6 22.6 13.95 21.95L11.05 19.05C10.4 18.4 10 17.5 10 16.5V14Z"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="26" cy="26" r="5" stroke="currentColor" strokeWidth="4" />
        </svg>
      </span>
      <span className="cy-side-action-label">工具</span>
    </button>
  );
}
