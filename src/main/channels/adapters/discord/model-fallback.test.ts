import { beforeEach, describe, expect, it } from "vitest";
import {
  activateDiscordGeminiFallback,
  canTryAlternateGeminiModel,
  DISCORD_OWNER_ID,
  GEMINI_STABLE_FALLBACK_MODEL,
  GEMINI_PROVIDER_NAME,
  getConfiguredGeminiFallback,
  getGeminiOwnerFallback,
  isDiscordGeminiFallbackActive,
  isDiscordNonOwnerQuotaFailure,
  isOpenRouterFreeQuotaError,
  isRetryableGeminiError,
  resetDiscordGeminiFallback,
  shouldIgnoreDiscordMessageDuringGeminiFallback,
  type DiscordPrimaryModelSettings,
} from "./model-fallback";

const settings: DiscordPrimaryModelSettings = {
  provider: "Custom",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openrouter/free",
  apiKey: "openrouter-key",
  perProvider: {
    [GEMINI_PROVIDER_NAME]: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-3.5-flash",
      apiKey: "gemini-key",
      explicitTransport: "openai",
    },
  },
};

describe("Discord Gemini quota fallback", () => {
  const quotaError = new Error("模型請求失敗：HTTP 429 — free-models-per-day remaining: 0");

  beforeEach(() => resetDiscordGeminiFallback());

  it("recognizes only OpenRouter free quota exhaustion", () => {
    expect(isOpenRouterFreeQuotaError(quotaError, settings)).toBe(true);
    expect(isOpenRouterFreeQuotaError(new Error("LLM HTTP 402: insufficient credits"), settings)).toBe(true);
    expect(isOpenRouterFreeQuotaError(new Error("No free models available"), settings)).toBe(true);
    expect(isOpenRouterFreeQuotaError(new Error("HTTP 429: Too Many Requests"), settings)).toBe(true);
    expect(isOpenRouterFreeQuotaError(new Error("HTTP 500"), settings)).toBe(false);
    expect(isOpenRouterFreeQuotaError(quotaError, { ...settings, model: "paid/model" })).toBe(false);
    expect(isOpenRouterFreeQuotaError(quotaError, { ...settings, baseUrl: "https://api.openai.com/v1" })).toBe(false);
  });

  it("returns the configured Gemini profile only for the owner", () => {
    expect(getGeminiOwnerFallback(settings, DISCORD_OWNER_ID, quotaError)).toMatchObject({
      provider: GEMINI_PROVIDER_NAME,
      model: "gemini-3.5-flash",
      apiKey: "gemini-key",
    });
    expect(getGeminiOwnerFallback(settings, "friend", quotaError)).toBeNull();
  });

  it("keeps Gemini fallback active after quota exhaustion is detected", () => {
    expect(isDiscordGeminiFallbackActive()).toBe(false);
    activateDiscordGeminiFallback();
    expect(isDiscordGeminiFallbackActive()).toBe(true);
    expect(shouldIgnoreDiscordMessageDuringGeminiFallback("friend")).toBe(true);
    expect(shouldIgnoreDiscordMessageDuringGeminiFallback(DISCORD_OWNER_ID)).toBe(false);
    expect(getConfiguredGeminiFallback(settings)).toMatchObject({
      provider: GEMINI_PROVIDER_NAME,
      model: "gemini-3.5-flash",
    });
  });

  it("retries temporary Gemini failures and permits a stable model fallback", () => {
    expect(GEMINI_STABLE_FALLBACK_MODEL).toBe("gemini-3.5-flash-lite");
    expect(isRetryableGeminiError(new Error("HTTP 503: high demand UNAVAILABLE"))).toBe(true);
    expect(isRetryableGeminiError(new Error("HTTP 400: invalid request"))).toBe(false);
    expect(canTryAlternateGeminiModel(new Error("HTTP 503: high demand"))).toBe(true);
    expect(canTryAlternateGeminiModel(new Error("HTTP 400: model unavailable"))).toBe(true);
    expect(canTryAlternateGeminiModel(new Error("HTTP 401: API_KEY_INVALID"))).toBe(false);
  });

  it("marks a non-owner quota failure without granting Gemini access", () => {
    expect(isDiscordNonOwnerQuotaFailure(settings, "friend", quotaError)).toBe(true);
    expect(isDiscordNonOwnerQuotaFailure(settings, DISCORD_OWNER_ID, quotaError)).toBe(false);
  });

  it("does not fall back when Gemini is not configured", () => {
    expect(getGeminiOwnerFallback({ ...settings, perProvider: {} }, DISCORD_OWNER_ID, quotaError)).toBeNull();
  });
});
