import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./SkillModePanel.css";

type SkillMode = "work" | "code" | "learn";
type TabKey = SkillMode;
type SkillSource = "builtin" | "user";

interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: SkillSource;
  modes: SkillMode[] | null;
  version?: string;
  references: string[];
}

type Overrides = Record<string, Partial<Record<SkillMode, boolean>>>;

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

const SOURCE_OPTIONS: Array<{ key: "all" | SkillSource; label: string }> = [
  { key: "all", label: "全部" },
  { key: "builtin", label: "内置" },
  { key: "user", label: "用户" },
];

// TODO: 为每个 skill 配置专属 SVG 图标；key 为 skill id。
const SKILL_ICON_SVGS: Record<string, React.ReactNode> = {};

function RefreshIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M36.7279 36.7279C33.4706 39.9853 28.9706 42 24 42C14.0589 42 6 33.9411 6 24C6 14.0589 14.0589 6 24 6C28.9706 6 33.4706 8.01472 36.7279 11.2721C38.3859 12.9301 42 17 42 17"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M42 8V17H33" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlaceholderIcon({ name }: { name: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "S";
  return <span className="skill-card__icon-letter">{letter}</span>;
}

function hashHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function SkillIcon({ skillId, name }: { skillId: string; name: string }) {
  const hue = hashHue(skillId);
  return (
    <span
      className="skill-card__icon"
      style={{ background: `hsl(${hue}, 82%, 94%)`, color: `hsl(${hue}, 55%, 42%)` }}
    >
      {SKILL_ICON_SVGS[skillId] ?? <PlaceholderIcon name={name} />}
    </span>
  );
}

/** 与主进程 getEnabledForMode 同源的默认可见性计算（前端镜像） */
function isVisibleForMode(skill: SkillCatalogItem, mode: SkillMode, overrides: Overrides): boolean {
  const override = overrides[skill.id]?.[mode];
  if (override !== undefined) return override;
  if (!skill.modes) return true;
  return skill.modes.includes(mode);
}

export const SkillModePanel: React.FC = () => {
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState<"all" | SkillSource>("all");
  const [tab, setTab] = useState<TabKey>("code");

  const load = useCallback(async () => {
    const api = window.settings;
    const [cat, ov] = await Promise.all([
      api?.getSkillCatalog?.() ?? Promise.resolve([]),
      api?.getSkillModeOverrides?.() ?? Promise.resolve({}),
    ]);
    setCatalog(cat as SkillCatalogItem[]);
    setOverrides(ov as Overrides);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err) => console.warn("[SkillModePanel] load failed:", err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await window.settings?.rescanSkills?.();
      if (res && !res.ok) {
        console.warn("[SkillModePanel] rescan failed:", res.error);
      }
      await load();
    } catch (err) {
      console.warn("[SkillModePanel] refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const toggleMode = useCallback((skillId: string, mode: SkillMode, next: boolean) => {
    setOverrides((prev) => ({
      ...prev,
      [skillId]: { ...prev[skillId], [mode]: next },
    }));
    void window.settings
      ?.setSkillModeOverride?.(skillId, mode, next)
      ?.catch((err) => console.warn("[SkillModePanel] set override failed:", err));
  }, []);

  const visibleSkills = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const candidates = catalog.filter((s) => {
      if (source !== "all" && s.source !== source) return false;
      return true;
    });
    const shown = candidates.filter((s) => s.enabled && isVisibleForMode(s, tab, overrides));
    const searched = kw
      ? shown.filter(
          (s) =>
            s.id.toLowerCase().includes(kw) ||
            s.name.toLowerCase().includes(kw) ||
            s.description.toLowerCase().includes(kw),
        )
      : shown;
    return [...searched].sort((a, b) => {
      const aOn = isVisibleForMode(a, tab, overrides);
      const bOn = isVisibleForMode(b, tab, overrides);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [catalog, overrides, filter, source, tab]);

  return (
    <div className="skill-panel">
      <header className="skill-panel__header">
        <div className="skill-panel__header-row">
          <div>
            <h1 className="skill-panel__title">技能</h1>
            <p className="skill-panel__subtitle">
              {`管理 skill 在 ${TABS.find((t) => t.key === tab)?.label} 模式下的可见性`}
            </p>
          </div>
          <div className="skill-panel__actions">
            <button
              type="button"
              className="skill-panel__icon-btn"
              title="重新扫描 user skills"
              disabled={refreshing}
              onClick={handleRefresh}
            >
              <RefreshIcon />
            </button>
          </div>
        </div>
      </header>

      <div className="skill-panel__search-row">
        <input
          className="skill-panel__search"
          placeholder="搜索 skill…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="skill-panel__tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={"skill-panel__tab" + (tab === t.key ? " is-active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="skill-panel__filter-row">
        {SOURCE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={
              "skill-panel__filter-tab" + (source === opt.key ? " is-active" : "")
            }
            onClick={() => setSource(opt.key)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="skill-panel__loading">加载中…</div>
      ) : (
        <div className="skill-panel__list">
          {visibleSkills.map((skill) => {
            const isOn = isVisibleForMode(skill, tab, overrides);
            return (
              <div key={skill.id} className={"skill-card" + (isOn ? "" : " is-off")}>
                <div className="skill-card__top">
                  <SkillIcon skillId={skill.id} name={skill.name} />
                  <div className="skill-card__body">
                    <div className="skill-card__name">
                      {skill.name}
                      {!skill.enabled && <span className="skill-card__badge">已禁用</span>}
                    </div>
                    <div className="skill-card__meta">
                      <span className={`skill-card__source skill-card__source--${skill.source}`}>
                        {skill.source === "builtin" ? "内置" : "用户"}
                      </span>
                      {skill.version ? (
                        <span className="skill-card__version">v{skill.version}</span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isOn}
                    className={"skill-card__pill" + (isOn ? " is-on" : "")}
                    onClick={() => toggleMode(skill.id, tab, !isOn)}
                  >
                    <span className="skill-card__pill-knob" />
                  </button>
                </div>
                <div className="skill-card__desc">
                  {skill.description.split("\n")[0] || "暂无描述"}
                </div>
              </div>
            );
          })}
          {visibleSkills.length === 0 && <div className="skill-panel__empty">无匹配 skill</div>}
        </div>
      )}
    </div>
  );
};

export default SkillModePanel;
