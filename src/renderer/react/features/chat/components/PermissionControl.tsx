import { Popover } from "antd";
import { useEffect, useState } from "react";

type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";

interface PermissionSettingsApi {
  getPermissionLevel?: () => Promise<{ level: PermissionLevel }>;
  setPermissionLevel?: (level: PermissionLevel) => Promise<{ ok: boolean; level?: PermissionLevel }>;
}

const PERMISSION_OPTIONS: ReadonlyArray<{ level: PermissionLevel; label: string }> = [
  { level: "project-read-only", label: "完全只读" },
  { level: "read-only", label: "允许访问" },
  { level: "scoped", label: "指定目录" },
  { level: "per-action", label: "请求审批" },
  { level: "full", label: "完全访问" },
];

function permissionApi(): PermissionSettingsApi | undefined {
  return (window as typeof window & { settings?: PermissionSettingsApi }).settings;
}

function PermissionIcon({ level }: { level: PermissionLevel }) {
  if (level === "scoped") {
    return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><path d="M14 21h8l2.5 3H34v8H14v-11Z" /></svg>;
  }
  if (level === "per-action") {
    return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><circle cx="22" cy="22" r="6" /><path d="m26.5 26.5 5 5" /></svg>;
  }
  if (level === "full") {
    return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><path d="M24 15v14" /><circle cx="24" cy="35" r="1.4" fill="currentColor" stroke="none" /></svg>;
  }
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><path d="m15 23 7 7 12-12" /></svg>;
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

function labelFor(level: PermissionLevel): string {
  return PERMISSION_OPTIONS.find((option) => option.level === level)?.label ?? "允许访问";
}

export function PermissionControl() {
  const [level, setLevel] = useState<PermissionLevel>("read-only");
  const [open, setOpen] = useState(false);

  async function refresh() {
    try {
      const state = await permissionApi()?.getPermissionLevel?.();
      if (state) setLevel(state.level);
    } catch {
      setLevel("read-only");
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function select(nextLevel: PermissionLevel) {
    try {
      const result = await permissionApi()?.setPermissionLevel?.(nextLevel);
      if (result?.ok) setLevel(result.level ?? nextLevel);
      setOpen(false);
    } catch {
      await refresh();
    }
  }

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void refresh();
      }}
      overlayClassName="cy-permission-popover"
      content={
        <div className="cy-permission-panel">
          <strong>权限等级</strong>
          <div className="cy-permission-panel__options">
            {PERMISSION_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.level}
                className={`cy-permission-panel__option is-${option.level} ${level === option.level ? "is-active" : ""}`}
                onClick={() => void select(option.level)}
              >
                <PermissionIcon level={option.level} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      <button type="button" className={`cy-composer__footer-button cy-permission-control is-${level}`}>
        <PermissionIcon level={level} />
        <span>{labelFor(level)}</span>
        <ChevronIcon />
      </button>
    </Popover>
  );
}
