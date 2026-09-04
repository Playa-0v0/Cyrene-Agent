import { Download, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import type { AppUpdateState } from "../../../../../shared/app-update";
import "./AppUpdateEntry.css";

export interface AppUpdateEntryView {
  label: string;
  action: "download" | "install" | null;
  disabled: boolean;
}

export function resolveAppUpdateEntryView(state: AppUpdateState): AppUpdateEntryView | null {
  switch (state.phase) {
    case "available":
      return {
        label: state.availableVersion ? t("appUpdate.availableWithVersion", { version: state.availableVersion }) : t("appUpdate.available"),
        action: "download",
        disabled: false,
      };
    case "downloading":
      return {
        label: t("appUpdate.downloading", { percent: Math.max(0, Math.min(100, Math.round(state.percent ?? 0))) }),
        action: null,
        disabled: true,
      };
    case "downloaded":
      return { label: t("appUpdate.restart"), action: "install", disabled: false };
    default:
      return null;
  }
}

export function AppUpdateEntry() {
  const api = window.appUpdate;
  const [state, setState] = useState<AppUpdateState>({ phase: "idle", currentVersion: "" });

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.getState().then((next) => {
      if (active) setState(next);
    });
    const unsubscribe = api.onStateChanged((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const view = resolveAppUpdateEntryView(state);
  if (!api || !view) return null;

  const handleClick = () => {
    if (view.action === "download") void api.download();
    if (view.action === "install") void api.install();
  };

  return (
    <button
      type="button"
      className={`cy-app-update-entry is-${state.phase}`}
      disabled={view.disabled}
      onClick={handleClick}
      title={state.releaseNotes || view.label}
    >
      {state.phase === "downloaded" ? <RotateCcw size={15} /> : <Download size={15} />}
      <span>{view.label}</span>
      {state.phase === "downloading" && (
        <span className="cy-app-update-entry__progress" style={{ width: `${Math.max(0, Math.min(100, state.percent ?? 0))}%` }} />
      )}
    </button>
  );
}
