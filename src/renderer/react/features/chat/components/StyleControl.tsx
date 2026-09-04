import { Popover } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import { normalizeStyleId, type StyleId } from "../../../../../shared/style-sampling";
import gentleIconUrl from "../../../assets/status-moods/温柔.png?url";
import livelyIconUrl from "../../../assets/status-moods/元气.png?url";
import healingIconUrl from "../../../assets/status-moods/治愈.png?url";
import focusedIconUrl from "../../../assets/status-moods/知性.png?url";
import sweetIconUrl from "../../../assets/status-moods/撒娇.png?url";
import customIconUrl from "../../../assets/status-moods/自定义.png?url";

// 只存 i18n key 与风格 id（id 是存储值不能改；t() 不能出现在模块顶层常量里），
// 展示文案在组件内求值。
const STYLE_OPTIONS: ReadonlyArray<{ id: StyleId; labelKey: string; iconUrl: string }> = [
  { id: "default", labelKey: "style.optionDefault", iconUrl: gentleIconUrl },
  { id: "lively", labelKey: "style.optionLively", iconUrl: livelyIconUrl },
  { id: "healing", labelKey: "style.optionHealing", iconUrl: healingIconUrl },
  { id: "focused", labelKey: "style.optionFocused", iconUrl: focusedIconUrl },
  { id: "sweet", labelKey: "style.optionSweet", iconUrl: sweetIconUrl },
  { id: "custom", labelKey: "style.optionCustom", iconUrl: customIconUrl },
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
  const { t } = useTranslation();
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
          <strong>{t("style.panelTitle")}</strong>
          <div className="cy-style-panel__options">
            {STYLE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={`cy-style-panel__option ${option.id === styleId ? "is-active" : ""}`}
                onClick={() => void select(option.id)}
              >
                <img className="cy-style-icon" src={option.iconUrl} alt="" />
                <span>{t(option.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      <button type="button" className="cy-composer__agent-button cy-style-control">
        <img className="cy-style-icon" src={current.iconUrl} alt="" />
        <span>style · {t(current.labelKey)}</span>
        <ChevronIcon />
      </button>
    </Popover>
  );
}
