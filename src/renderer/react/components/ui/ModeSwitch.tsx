interface ModeSwitchProps {
  value: string;
  onChange: (mode: string) => void;
}

const WorkIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
    <rect x="3" y="3.5" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M7 16.5H13M10 13.5V16.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const ChatIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
    <path d="M16.5 9.25C16.5 12.43 13.59 15 10 15C9.22 15 8.47 14.88 7.78 14.65L4.5 16L5.35 13.17C4.2 12.16 3.5 10.78 3.5 9.25C3.5 6.07 6.41 3.5 10 3.5C13.59 3.5 16.5 6.07 16.5 9.25Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M7.5 9.25H7.51M10 9.25H10.01M12.5 9.25H12.51" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const CodeIcon = (
  <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
    <path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
    <path d="M28 22L33 27L28 32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 22L15 27L20 32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const LearnIcon = (
  <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
    <path d="M32 6H22V42H32V6Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
    <path d="M42 6H32V42H42V6Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
    <path d="M10 6L18 7L14.5 42L6 41L10 6Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
    <path d="M37 18V15" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M27 18V15" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const modes = [
  { key: "work", label: "Work", icon: WorkIcon },
  { key: "chat", label: "Chat", icon: ChatIcon },
  { key: "code", label: "Code", icon: CodeIcon },
  { key: "learn", label: "Learn", icon: LearnIcon },
];

export function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  return (
    <div className="cy-segmented">
      {modes.map((mode) => (
        <button
          key={mode.key}
          className={`cy-segment ${mode.key === value ? "is-active" : ""}`}
          onClick={() => onChange(mode.key)}
        >
          <span className="cy-segment-icon">{mode.icon}</span>
          <span className="cy-segment-label">{mode.label}</span>
        </button>
      ))}
    </div>
  );
}
