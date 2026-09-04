import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import "./ToolModePanel.css";

type ToolMode = "work" | "code" | "learn" | "chat";

type TabKey = ToolMode;

interface ToolCatalogItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  modes: Array<"chat" | "work" | "code" | "learn"> | null;
  deprecated: string | null;
}

type Overrides = Record<string, Partial<Record<string, boolean>>>;

const BASE_TABS: Array<{ key: TabKey; label: string }> = [
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

/** Chat 模式首次开启工具增强时预勾选的白名单：音乐全量 + 幂等只读。
 *  播放类是闲聊刚需故全放（input-control 级仍受权限档位门控）；
 *  只读类无副作用。写入后完全由用户接管，后续开关不再覆盖。 */
const CHAT_TOOL_WHITELIST = [
  // 音乐工具（全量）
  "music_search",
  "music_get_daily_recommendations",
  "music_get_playback_status",
  "music_my_playlists",
  "music_playlist_detail",
  "music_play_track",
  "music_play_playlist",
  "music_stop_playback",
  "music_create_playlist",
  "music_add_to_playlist",
  "music_toggle_favorite",
  "music_remove_from_playlist",
  // 幂等只读
  "weather",
  "web_search",
  "fetch_url",
  "translate",
  "exchange_rate",
  "query_expense",
  "recall_history",
];

/** Chat 模式可见性：严格 opt-in，仅显式勾选（override.chat===true）放行。
 *  不走"未声明 modes 即全可见"的默认规则——与主进程 run-capabilities 同口径。 */
function isChatToolOn(tool: ToolCatalogItem, overrides: Overrides): boolean {
  return overrides[tool.id]?.chat === true;
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4ZM0 24C0 10.7452 10.7452 0 24 0C37.2548 0 48 10.7452 48 24C48 37.2548 37.2548 48 24 48C10.7452 48 0 37.2548 0 24Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M19.1833 45.4716C18.9898 45.2219 18.9898 42.9973 19.1833 38.798C17.1114 38.8696 15.8024 38.7258 15.2563 38.3667C14.437 37.828 13.6169 36.1667 12.8891 34.9959C12.1614 33.8251 10.5463 33.64 9.89405 33.3783C9.24182 33.1165 9.07809 32.0496 11.6913 32.8565C14.3044 33.6634 14.4319 35.8607 15.2563 36.3745C16.0806 36.8883 18.0515 36.6635 18.9448 36.2519C19.8382 35.8403 19.7724 34.3078 19.9317 33.7007C20.1331 33.134 19.4233 33.0083 19.4077 33.0037C18.5355 33.0037 13.9539 32.0073 12.6955 27.5706C11.437 23.134 13.0581 20.2341 13.9229 18.9875C14.4995 18.1564 14.4485 16.3852 13.7699 13.6737C16.2335 13.3589 18.1347 14.1343 19.4734 16.0001C19.4747 16.0108 21.2285 14.9572 24.0003 14.9572C26.772 14.9572 27.7553 15.8154 28.5142 16.0001C29.2731 16.1848 29.88 12.7341 34.5668 13.6737C33.5883 15.5969 32.7689 18.0001 33.3943 18.9875C34.0198 19.9749 36.4745 23.1147 34.9666 27.5706C33.9614 30.5413 31.9853 32.3523 29.0384 33.0037C28.7005 33.1115 28.5315 33.2855 28.5315 33.5255C28.5315 33.8856 28.9884 33.9249 29.6465 35.6117C30.0853 36.7362 30.117 39.948 29.7416 45.247C28.7906 45.4891 28.0508 45.6516 27.5221 45.7347C26.5847 45.882 25.5669 45.9646 24.5669 45.9965C23.5669 46.0284 23.2196 46.0248 21.837 45.8961C20.9154 45.8103 20.0308 45.6688 19.1833 45.4716Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PlaceholderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="16" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray="6 4" />
      <path d="M24 16V32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <path d="M16 24H32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// TODO: 为每个工具配置专属 SVG 图标；key 为工具 id，未配置时使用占位图标。
const TOOL_ICON_SVGS: Record<string, React.ReactNode> = {
  // Git 相关工具
  git_status: <GithubIcon />,
  git_init: <GithubIcon />,
  git_commit: <GithubIcon />,
  git_switch_branch: <GithubIcon />,
  git_push: <GithubIcon />,
  git_revert: <GithubIcon />,
  // 代码功能工具
  search_code: <GithubIcon />,
  lsp: <GithubIcon />,
  apply_patch: <GithubIcon />,
  str_replace: <GithubIcon />,
  ast_grep_search: <GithubIcon />,
  ast_grep_replace: <GithubIcon />,
  run_shell: <GithubIcon />,
  run_verification: <GithubIcon />,
};

function ToolIcon({ toolId }: { toolId: string }) {
  return (
    <span
      className="tool-card__icon"
      style={{
        background: "var(--cy-bg-page, #f5f5f5)",
        color: "var(--cy-text-muted, #6e6e73)",
      }}
    >
      {TOOL_ICON_SVGS[toolId] ?? <PlaceholderIcon />}
    </span>
  );
}

/** 与主进程 getEnabledToolsForMode 同源的默认可见性计算（前端镜像） */
function isVisibleForMode(tool: ToolCatalogItem, mode: ToolMode, overrides: Overrides): boolean {
  const override = overrides[tool.id]?.[mode];
  if (override !== undefined) return override;
  if (!tool.modes) return true;
  return tool.modes.includes(mode);
}

export const ToolModePanel: React.FC = () => {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolCatalogItem[]>([]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<TabKey>("code");
  // Chat 模式工具增强总开关（general-settings.chatToolsEnabled）
  const [chatToolsEnabled, setChatToolsEnabled] = useState(false);
  // 关总开关时若停在 Chat tab，回退到 Code（避免 tab 悬空）。
  const tabRef = useRef<TabKey>("code");
  tabRef.current = tab;

  useEffect(() => {
    let cancelled = false;
    const api = window.settings;
    Promise.all([
      api?.getToolCatalog?.() ?? Promise.resolve([]),
      api?.getToolModeOverrides?.() ?? Promise.resolve({}),
      api?.getGeneral?.() ?? Promise.resolve({}),
    ])
      .then(([catalog, ov, general]) => {
        if (cancelled) return;
        setTools(catalog as ToolCatalogItem[]);
        setOverrides(ov as Overrides);
        setChatToolsEnabled((general as { chatToolsEnabled?: boolean }).chatToolsEnabled === true);
      })
      .catch((err) => console.warn("[ToolModePanel] load failed:", err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const toggleMode = useCallback((toolId: string, mode: ToolMode, next: boolean) => {
    setOverrides((prev) => ({
      ...prev,
      [toolId]: { ...prev[toolId], [mode]: next },
    }));
    void window.settings
      ?.setToolModeOverride?.(toolId, mode, next)
      ?.catch((err) => console.warn("[ToolModePanel] set override failed:", err));
  }, []);

  /** 总开关切换：首次开启（尚无任何 chat override）时预勾选白名单，一次性初始化。 */
  const toggleChatTools = useCallback((next: boolean) => {
    const prevOverrides = overrides;
    const hasChatOverride = Object.values(prevOverrides).some((m) => m?.chat !== undefined);
    let payload: Record<string, unknown> = { chatToolsEnabled: next };
    let nextOverrides = prevOverrides;
    if (next && !hasChatOverride) {
      // 只预勾选目录里存在且全局启用的白名单工具，避免写入死键。
      const available = new Set(tools.filter((t) => !t.deprecated && t.enabled).map((t) => t.id));
      const initialized: Overrides = { ...prevOverrides };
      for (const toolId of CHAT_TOOL_WHITELIST) {
        if (available.has(toolId)) {
          initialized[toolId] = { ...(initialized[toolId] ?? {}), chat: true };
        }
      }
      nextOverrides = initialized;
      payload = { chatToolsEnabled: true, toolModeOverrides: initialized };
    }
    setChatToolsEnabled(next);
    setOverrides(nextOverrides);
    void window.settings
      ?.saveGeneral?.(payload)
      ?.catch((err) => console.warn("[ToolModePanel] save general failed:", err));
    if (next) setTab("chat");
    else if (tabRef.current === "chat") setTab("code");
  }, [overrides, tools]);

  const TABS = useMemo(
    () => (chatToolsEnabled ? [...BASE_TABS, { key: "chat" as TabKey, label: "Chat" }] : BASE_TABS),
    [chatToolsEnabled],
  );

  const isToolOn = useCallback((tool: ToolCatalogItem, mode: TabKey, ov: Overrides): boolean => {
    if (mode === "chat") return isChatToolOn(tool, ov);
    return isVisibleForMode(tool, mode, ov);
  }, []);

  const visibleTools = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const usable = tools.filter((t) => !t.deprecated);
    // 所有 tab 统一展示全部启用工具：关掉的工具置灰保留在列表里，便于重新开启。
    // （此前非 chat tab 会把 override=false 的工具直接过滤掉，导致关掉后无法再打开。）
    const shown = usable.filter((t) => t.enabled);
    const searched = kw
      ? shown.filter(
          (t) =>
            t.id.toLowerCase().includes(kw) ||
            t.name.toLowerCase().includes(kw) ||
            t.description.toLowerCase().includes(kw),
        )
      : shown;
    return [...searched].sort((a, b) => {
      const aOn = isToolOn(a, tab, overrides);
      const bOn = isToolOn(b, tab, overrides);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [tools, overrides, filter, tab, isToolOn]);

  return (
    <div className="tool-panel">
      <header className="tool-panel__header">
        <h1 className="tool-panel__title">{t("toolPanel.title")}</h1>
        <p className="tool-panel__subtitle">
          {t("toolPanel.subtitle", { mode: TABS.find((item) => item.key === tab)?.label })}
        </p>
      </header>

      <div className="tool-panel__master">
        <div className="tool-panel__master-text">
          <strong>{t("toolPanel.chatEnhanceTitle")}</strong>
          <span>{t("toolPanel.chatEnhanceDesc")}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={chatToolsEnabled}
          aria-label={t("toolPanel.chatEnhanceTitle")}
          className={"tool-card__pill tool-panel__master-pill" + (chatToolsEnabled ? " is-on" : "")}
          onClick={() => toggleChatTools(!chatToolsEnabled)}
        >
          <span className="tool-card__pill-knob" />
        </button>
      </div>

      <div className="tool-panel__search-row">
        <input
          className="tool-panel__search"
          placeholder={t("toolPanel.searchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="tool-panel__tabs">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            className={"tool-panel__tab" + (tab === tabItem.key ? " is-active" : "")}
            onClick={() => setTab(tabItem.key)}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="tool-panel__loading">{t("common.loading")}</div>
      ) : (
        <div className="tool-panel__grid">
          {visibleTools.map((tool) => {
            const isOn = isToolOn(tool, tab, overrides);
            return (
              <div key={tool.id} className={"tool-card" + (isOn ? "" : " is-off")}>
                <ToolIcon toolId={tool.id} />
                <div className="tool-card__body">
                  <div className="tool-card__name">
                    {tool.name}
                    {!tool.enabled && <span className="tool-card__badge">{t("toolPanel.disabledBadge")}</span>}
                  </div>
                  <div className="tool-card__desc">{tool.description.split("\n")[0] || t("toolPanel.noDescription")}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  className={"tool-card__pill" + (isOn ? " is-on" : "")}
                  onClick={() => toggleMode(tool.id, tab, !isOn)}
                >
                  <span className="tool-card__pill-knob" />
                </button>
              </div>
            );
          })}
          {visibleTools.length === 0 && <div className="tool-panel__empty">{t("toolPanel.noMatch")}</div>}
        </div>
      )}
    </div>
  );
};

export default ToolModePanel;
