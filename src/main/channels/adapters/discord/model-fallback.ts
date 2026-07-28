export const DISCORD_OWNER_ID = "798893182883463179";
export const GEMINI_PROVIDER_NAME = "Gemini（Google）";
export const GEMINI_STABLE_FALLBACK_MODEL = "gemini-3.5-flash-lite";

export interface DiscordModelProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

export interface DiscordPrimaryModelSettings extends DiscordModelProfile {
  provider: string;
  perProvider?: Record<string, DiscordModelProfile>;
}

let geminiFallbackActive = false;

export function isDiscordGeminiFallbackActive(): boolean {
  return geminiFallbackActive;
}

export function activateDiscordGeminiFallback(): void {
  geminiFallbackActive = true;
}

export function shouldIgnoreDiscordMessageDuringGeminiFallback(senderId: string): boolean {
  return geminiFallbackActive && senderId !== DISCORD_OWNER_ID;
}

/** Test and explicit-reconfiguration hook; normal quota fallback lasts for the process lifetime. */
export function resetDiscordGeminiFallback(): void {
  geminiFallbackActive = false;
}

export function isOpenRouterFreeQuotaError(
  error: unknown,
  settings: Pick<DiscordPrimaryModelSettings, "baseUrl" | "model">,
): boolean {
  if (!/openrouter\.ai/i.test(settings.baseUrl) || settings.model !== "openrouter/free") return false;
  const message = error instanceof Error ? error.message : String(error);
  const exhaustedStatus = /HTTP\s*(?:402|429)\b/i.test(message);
  const exhaustedDetail = /(?:free-models-per-day|rate[\s_-]*limit|quota|remaining["']?\s*:\s*["']?0|insufficient[\s_-]*(?:credits?|balance)|(?:credits?|balance).{0,24}(?:exhausted|depleted|used\s*up|too\s*low)|no\s+(?:free\s+)?models?\s+(?:available|remaining))/i.test(message);
  return exhaustedStatus || exhaustedDetail;
}

export function isRetryableGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*(?:429|500|502|503|504)\b|high\s+demand|UNAVAILABLE|RESOURCE_EXHAUSTED|temporar(?:y|ily)|overload/i.test(message);
}

export function canTryAlternateGeminiModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/HTTP\s*(?:401|403)\b|API[_\s-]*KEY(?:_INVALID)?|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message);
}

export function getGeminiOwnerFallback(
  settings: DiscordPrimaryModelSettings,
  senderId: string,
  error: unknown,
): DiscordModelProfile & { provider: typeof GEMINI_PROVIDER_NAME } | null {
  if (senderId !== DISCORD_OWNER_ID || !isOpenRouterFreeQuotaError(error, settings)) return null;
  return getConfiguredGeminiFallback(settings);
}

export function getConfiguredGeminiFallback(
  settings: DiscordPrimaryModelSettings,
): DiscordModelProfile & { provider: typeof GEMINI_PROVIDER_NAME } | null {
  const profile = settings.perProvider?.[GEMINI_PROVIDER_NAME];
  if (!profile?.apiKey?.trim() || !profile.baseUrl?.trim() || !profile.model?.trim()) return null;
  return {
    provider: GEMINI_PROVIDER_NAME,
    baseUrl: profile.baseUrl.trim(),
    model: profile.model.trim(),
    apiKey: profile.apiKey.trim(),
    explicitTransport: profile.explicitTransport ?? "openai",
  };
}

export function isDiscordNonOwnerQuotaFailure(
  settings: DiscordPrimaryModelSettings,
  senderId: string,
  error: unknown,
): boolean {
  return senderId !== DISCORD_OWNER_ID && isOpenRouterFreeQuotaError(error, settings);
}
