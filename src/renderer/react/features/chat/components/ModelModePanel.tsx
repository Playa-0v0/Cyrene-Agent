import { useCallback, useEffect, useMemo, useState } from "react";
import fallbackIconUrl from "../../../assets/status-moods/陪伴中.png?url";
import "./ModelModePanel.css";

interface ModelProfile {
  id: string;
  provider: string;
  displayName?: string;
  model: string;
  contextWindowTokens?: number;
  multimodal?: boolean;
}

interface ModelCatalogApi {
  listModelProfiles?: () => Promise<{ profiles: ModelProfile[]; defaultModelProfileId?: string }>;
  setDefaultModelProfile?: (id: string) => Promise<unknown>;
  deleteModelProfile?: (id: string) => Promise<unknown>;
}

const PROVIDER_ORDER = [
  "OpenAI",
  "Anthropic",
  "Google",
  "MiniMax（稀宇科技）",
  "GLM（智谱）",
  "Qwen（通义千问）",
  "DeepSeek（深度求索）",
  "Moonshot AI",
  "火山引擎",
];

function getProviderLabel(provider: string | undefined): string {
  if (!provider) return "未知厂商";
  // 如果 provider 已经是 "中文名" 或 "英文名（中文名）"，直接返回
  if (provider.includes("（") || provider.includes("）")) return provider;
  const map: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    minimax: "MiniMax（稀宇科技）",
    zhipu: "GLM（智谱）",
    qwen: "Qwen（通义千问）",
    deepseek: "DeepSeek（深度求索）",
    moonshot: "Moonshot AI",
    volcengine: "火山引擎",
  };
  return map[provider.toLowerCase()] ?? provider;
}

function getProviderSortKey(provider: string | undefined): number {
  if (!provider) return PROVIDER_ORDER.length;
  const idx = PROVIDER_ORDER.findIndex((p) => provider.includes(p) || p.includes(provider));
  return idx >= 0 ? idx : PROVIDER_ORDER.length;
}

function getProviderIconUrl(provider: string | undefined): string {
  if (!provider) return fallbackIconUrl;
  const normalized = provider.toLowerCase();
  const key = (() => {
    if (normalized.includes("minimax")) return "minimax";
    if (normalized.includes("deepseek")) return "deepseek";
    if (normalized.includes("火山") || normalized.includes("豆包") || normalized.includes("volcengine")) return "volcengine";
    if (normalized.includes("glm") || normalized.includes("智谱") || normalized.includes("zhipu")) return "glm";
    if (normalized.includes("kimi") || normalized.includes("moonshot")) return "kimi-light";
    if (normalized.includes("qwen") || normalized.includes("通义") || normalized.includes("dashscope")) return "qwen";
    if (normalized.includes("openai") || normalized.includes("chatgpt")) return "openai";
    if (normalized.includes("anthropic") || normalized.includes("claude")) return "claude";
    if (normalized.includes("mimo") || normalized.includes("小米")) return "xiaomimimo";
    if (normalized.includes("custom") || normalized.includes("自定义") || normalized.includes("本地模型")) return "custom-endpoint";
    return null;
  })();
  return key ? `../icons/providers/${key}.svg` : fallbackIconUrl;
}

function ModelIcon({ provider }: { provider: string }) {
  return (
    <img
      src={getProviderIconUrl(provider)}
      alt=""
      aria-hidden="true"
      width="24"
      height="24"
      style={{ objectFit: "contain" }}
    />
  );
}

export function ModelModePanel() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string>();
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const api = () => (window as typeof window & { settings?: ModelCatalogApi }).settings;

  const reload = useCallback(async () => {
    const catalog = await api()?.listModelProfiles?.();
    setProfiles(catalog?.profiles ?? []);
    setDefaultId(catalog?.defaultModelProfileId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((err) => console.warn("[ModelModePanel] load failed:", err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [reload]);

  const visibleProfiles = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const searched = kw
      ? profiles.filter(
          (p) =>
            p.id.toLowerCase().includes(kw) ||
            p.provider.toLowerCase().includes(kw) ||
            p.model.toLowerCase().includes(kw) ||
            (p.displayName && p.displayName.toLowerCase().includes(kw)),
        )
      : profiles;
    return [...searched].sort((a, b) => {
      // 默认模型置顶
      if (a.id === defaultId) return -1;
      if (b.id === defaultId) return 1;
      // 按厂商排序
      const pa = getProviderSortKey(a.provider);
      const pb = getProviderSortKey(b.provider);
      if (pa !== pb) return pa - pb;
      return a.model.localeCompare(b.model);
    });
  }, [profiles, defaultId, filter]);

  const handleSetDefault = useCallback((id: string) => {
    void api()
      ?.setDefaultModelProfile?.(id)
      .then(reload);
  }, [reload]);

  const handleDelete = useCallback((id: string) => {
    void api()
      ?.deleteModelProfile?.(id)
      .then(reload);
  }, [reload]);

  return (
    <div className="model-panel">
      <header className="model-panel__header">
        <h1 className="model-panel__title">模型</h1>
        <p className="model-panel__subtitle">默认模型用于新对话；当前对话可在输入框中单独切换。</p>
      </header>

      <div className="model-panel__search-row">
        <input
          className="model-panel__search"
          placeholder="搜索模型…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="model-panel__loading">加载中…</div>
      ) : (
        <div className="model-panel__grid">
          {profiles.length === 0 ? (
            <div className="model-panel__empty">请先到 API 设置保存模型。</div>
          ) : (
            visibleProfiles.map((profile) => {
              const isDefault = profile.id === defaultId;
              return (
                <div key={profile.id} className={"model-card" + (isDefault ? " is-default" : "")}>
                  <span className="model-card__icon">
                    <ModelIcon provider={profile.provider} />
                  </span>
                  <div className="model-card__body">
                    <div className="model-card__name">
                      {profile.displayName || profile.provider}
                      {isDefault && <span className="model-card__badge">默认</span>}
                      {profile.multimodal === true && <span className="model-card__badge">多模态</span>}
                      {profile.contextWindowTokens ? (
                        <span className="model-card__badge">{Math.round(profile.contextWindowTokens / 1000)}k</span>
                      ) : null}
                    </div>
                    <div className="model-card__meta">
                      <span className="model-card__provider">{getProviderLabel(profile.provider)}</span>
                    </div>
                    <div className="model-card__desc">{profile.model}</div>
                  </div>
                  <div className="model-card__actions">
                    <button
                      type="button"
                      className={"model-card__pill" + (isDefault ? " is-on" : "")}
                      disabled={isDefault}
                      onClick={() => handleSetDefault(profile.id)}
                      title={isDefault ? "当前默认模型" : "设为默认"}
                    >
                      {isDefault ? "默认" : "设为默认"}
                    </button>
                    <button
                      type="button"
                      className="model-card__delete"
                      onClick={() => handleDelete(profile.id)}
                      title="删除"
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })
          )}
          {profiles.length > 0 && visibleProfiles.length === 0 && (
            <div className="model-panel__empty">无匹配模型</div>
          )}
        </div>
      )}
    </div>
  );
}

export default ModelModePanel;
