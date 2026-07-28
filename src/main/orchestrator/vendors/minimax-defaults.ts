const MINIMAX_PROVIDER = "MiniMax（稀宇科技）";
const LEGACY_ANTHROPIC_DEFAULT = "https://api.minimaxi.com/anthropic";
const OPENAI_DEFAULT = "https://api.minimaxi.com/v1";

type TransportPreference = "openai" | "anthropic" | "auto";

/** Migrate only the old shipped default; an explicit Anthropic choice remains authoritative. */
export function migrateLegacyMinimaxDefaults<T extends {
  baseUrl: string;
  explicitTransport?: TransportPreference;
}>(provider: string, profile: T): T {
  if (
    provider !== MINIMAX_PROVIDER
    || profile.baseUrl !== LEGACY_ANTHROPIC_DEFAULT
    || profile.explicitTransport === "anthropic"
  ) return profile;
  return { ...profile, baseUrl: OPENAI_DEFAULT };
}
