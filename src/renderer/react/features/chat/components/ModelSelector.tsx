import { Popover } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";

interface ModelProfile { id: string; provider: string; displayName?: string; model: string; }
interface ModelCatalogApi {
  listModelProfiles?: () => Promise<{ profiles: ModelProfile[]; defaultModelProfileId?: string }>;
}

export function ModelSelector({ activeProfileId, onSelect }: { activeProfileId?: string; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string>();
  const [open, setOpen] = useState(false);
  const load = async () => {
    const result = await ((window as typeof window & { settings?: ModelCatalogApi }).settings?.listModelProfiles?.());
    setProfiles(result?.profiles ?? []);
    setDefaultProfileId(result?.defaultModelProfileId);
  };
  useEffect(() => { void load(); }, []);
  const active = profiles.find((item) => item.id === activeProfileId) ?? profiles.find((item) => item.id === defaultProfileId) ?? profiles[0];
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }} trigger="click" placement="topLeft"
      content={<div className="cy-model-selector__menu">{profiles.length ? profiles.map((profile) => <button type="button" key={profile.id} onClick={() => { onSelect(profile.id); setOpen(false); }}><strong>{profile.displayName || profile.provider}</strong><small>{profile.model}</small></button>) : <span>{t("modelSelector.emptyHint")}</span>}</div>}>
      <button type="button" className="cy-composer__agent-button cy-model-selector" title={t("modelSelector.switchTitle")}><span>{active?.displayName || active?.model || t("modelSelector.chooseModel")}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>
    </Popover>
  );
}
