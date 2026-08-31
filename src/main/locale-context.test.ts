import { describe, expect, it, beforeEach } from "vitest";
import {
  updateLocaleContext,
  getLocaleContext,
  getDateLocale,
  getWeatherLanguage,
  getMemoryLanguage,
  getAsrLanguage,
} from "./locale-context";

beforeEach(() => {
  // Reset to defaults before each test
  updateLocaleContext({
    uiLocale: "zh-CN",
    dateLocale: "zh-CN",
    weatherLanguage: "zh",
    responseLanguage: "zh-CN",
    memoryLanguage: "zh-CN",
    asrLanguage: "zh",
  });
});

describe("LocaleContext defaults", () => {
  it("returns Chinese defaults before any update", () => {
    // After reset, should be defaults
    expect(getDateLocale()).toBe("zh-CN");
    expect(getWeatherLanguage()).toBe("zh");
    expect(getMemoryLanguage()).toBe("zh-CN");
    expect(getAsrLanguage()).toBe("zh");
  });
});

describe("updateLocaleContext", () => {
  it("updates dateLocale independently", () => {
    updateLocaleContext({ dateLocale: "en-US" });
    expect(getDateLocale()).toBe("en-US");
    // Others unchanged
    expect(getWeatherLanguage()).toBe("zh");
    expect(getMemoryLanguage()).toBe("zh-CN");
  });

  it("auto-derives weatherLanguage from uiLocale", () => {
    updateLocaleContext({ uiLocale: "en-US" });
    expect(getWeatherLanguage()).toBe("en");
    expect(getMemoryLanguage()).toBe("en-US");
    expect(getAsrLanguage()).toBe("en");
  });

  it("explicit weatherLanguage overrides auto-derivation", () => {
    updateLocaleContext({ uiLocale: "ja-JP", weatherLanguage: "ja" });
    expect(getWeatherLanguage()).toBe("ja");
  });

  it("explicit asrLanguage overrides auto-derivation", () => {
    updateLocaleContext({ uiLocale: "en-US", asrLanguage: "auto" });
    expect(getAsrLanguage()).toBe("auto");
  });
});

describe("normalization", () => {
  it("empty string falls back to default", () => {
    updateLocaleContext({ dateLocale: "" });
    expect(getDateLocale()).toBe("zh-CN");
  });

  it("whitespace-only falls back to default", () => {
    updateLocaleContext({ dateLocale: "   " });
    expect(getDateLocale()).toBe("zh-CN");
  });

  it("trims whitespace from valid value", () => {
    updateLocaleContext({ dateLocale: "  en-US  " });
    expect(getDateLocale()).toBe("en-US");
  });
});

describe("language mapping", () => {
  it("zh-CN maps to weather zh", () => {
    expect(getWeatherLanguage()).toBe("zh");
  });

  it("en-US maps to weather en", () => {
    updateLocaleContext({ uiLocale: "en-US" });
    expect(getWeatherLanguage()).toBe("en");
  });

  it("ja-JP maps to weather ja", () => {
    updateLocaleContext({ uiLocale: "ja-JP" });
    expect(getWeatherLanguage()).toBe("ja");
  });

  it("unknown locale maps to weather en", () => {
    updateLocaleContext({ uiLocale: "pt-BR" });
    expect(getWeatherLanguage()).toBe("en");
  });
});

describe("sequential updates", () => {
  it("second update does not preserve first update's derived values", () => {
    updateLocaleContext({ uiLocale: "en-US" });
    expect(getWeatherLanguage()).toBe("en");

    updateLocaleContext({ uiLocale: "zh-CN" });
    expect(getWeatherLanguage()).toBe("zh");
  });
});
