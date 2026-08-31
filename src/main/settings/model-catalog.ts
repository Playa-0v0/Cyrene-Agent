import type { ProviderProfile } from "./model-settings";

export interface SavedModelProfile extends ProviderProfile {
  id: string;
  provider: string;
}

/**
 * 档案级去重：apiKey + model + baseUrl 三者全同才算重复。
 * 同 Key 同模型但不同中转站（baseUrl 不同）、或刻意建两份不同上下文的配置都是合法需求。
 */
export function sameModelCredential(left: SavedModelProfile, right: SavedModelProfile): boolean {
  return left.apiKey.trim() === right.apiKey.trim()
    && left.model.trim() === right.model.trim()
    && left.baseUrl.trim() === right.baseUrl.trim();
}

export function addModelProfile(
  profiles: SavedModelProfile[],
  profile: SavedModelProfile,
): { profiles: SavedModelProfile[]; added: boolean } {
  if (profiles.some((saved) => sameModelCredential(saved, profile))) {
    return { profiles, added: false };
  }
  return { profiles: [...profiles, profile], added: true };
}

/** 按 id 更新档案（字段全量覆盖，表单即全量）。找不到返回 null。 */
export function updateModelProfile(
  profiles: SavedModelProfile[],
  profile: SavedModelProfile,
): SavedModelProfile[] | null {
  const index = profiles.findIndex((saved) => saved.id === profile.id);
  if (index < 0) return null;
  const next = [...profiles];
  next[index] = profile;
  return next;
}

export function resolveDefaultModelProfile(
  profiles: SavedModelProfile[],
  defaultModelProfileId: string | undefined,
): SavedModelProfile | undefined {
  return profiles.find((profile) => profile.id === defaultModelProfileId) ?? profiles[0];
}
