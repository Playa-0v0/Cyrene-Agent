import { Popover } from "antd";
import { useEffect, useState } from "react";
import { normalizeStyleId, type StyleId } from "../../../../../shared/style-sampling";
import gentleIconUrl from "../../../assets/status-moods/温柔.png?url";
import livelyIconUrl from "../../../assets/status-moods/元气.png?url";
import healingIconUrl from "../../../assets/status-moods/治愈.png?url";
import focusedIconUrl from "../../../assets/status-moods/知性.png?url";
import sweetIconUrl from "../../../assets/status-moods/撒娇.png?url";
import customIconUrl from "../../../assets/status-moods/自定义.png?url";

const STYLE_OPTIONS: ReadonlyArray<{ id: StyleId; label: string; iconUrl: string }> = [
  { id: "default", label: "温柔 · 和善", iconUrl: gentleIconUrl },
  { id: "lively", label: "元气 · 活泼", iconUrl: livelyIconUrl },
  { id: "healing", label: "治愈 · 安心", iconUrl: healingIconUrl },
  { id: "focused", label: "知性 · 认真", iconUrl: focusedIconUrl },
  { id: "sweet", label: "撒娇 · 黏人", iconUrl: sweetIconUrl },
  { id: "custom", label: "自定义", iconUrl: customIconUrl },
];

interface StyleSettingsApi {
  getGeneral?: () => Promise<{ currentStyleId?: StyleId }>;
  saveGeneral?: (config: { currentStyleId: StyleId }) => Promise<unknown>;
}

function styleSettingsApi(): StyleSettingsApi | undefined {
  return (window as typeof window & { settings?: StyleSettingsApi }).settings;
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

export function StyleControl() {
  const [styleId, setStyleId] = useState<StyleId>("default");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void styleSettingsApi()?.getGeneral?.().then((settings) => {
      setStyleId(normalizeStyleId(settings.currentStyleId));
    });
  }, []);

  const current = STYLE_OPTIONS.find((option) => option.id === styleId) ?? STYLE_OPTIONS[0];

  async function select(nextStyleId: StyleId) {
    setStyleId(nextStyleId);
    setOpen(false);
    try {
      await styleSettingsApi()?.saveGeneral?.({ currentStyleId: nextStyleId });
    } catch {
      setStyleId(styleId);
    }
  }

  return (
    <Popover
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={setOpen}
      overlayClassName="cy-style-popover"
      content={
        <div className="cy-style-panel">
          <strong>回复风格</strong>
          <div className="cy-style-panel__options">
            {STYLE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={`cy-style-panel__option ${option.id === styleId ? "is-active" : ""}`}
                onClick={() => void select(option.id)}
              >
                <img className="cy-style-icon" src={option.iconUrl} alt="" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      <button type="button" className="cy-composer__agent-button cy-style-control">
        <img className="cy-style-icon" src={current.iconUrl} alt="" />
        <span>style · {current.label}</span>
        <ChevronIcon />
      </button>
    </Popover>
  );
}
