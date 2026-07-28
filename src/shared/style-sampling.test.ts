import { describe, expect, it } from "vitest";
import {
  BUILT_IN_STYLE_PRESETS,
  DEFAULT_CUSTOM_STYLE,
  STYLE_FILE_BY_ID,
  normalizeCustomStyleConfig,
  normalizeStyleId,
  resolveStylePreference,
} from "./style-sampling";

describe("style sampling preferences", () => {
  it("falls back invalid style IDs to default", () => {
    expect(normalizeStyleId("../../evil.md")).toBe("default");
  });

  it("keeps the five approved presets exact", () => {
    expect(BUILT_IN_STYLE_PRESETS).toEqual({
      default: { diversity: { driver: "temperature", value: 0.65 }, repetition: "model-default" },
      lively: { diversity: { driver: "temperature", value: 0.90 }, repetition: "light" },
      healing: { diversity: { driver: "temperature", value: 0.55 }, repetition: "model-default" },
      focused: { diversity: { driver: "temperature", value: 0.40 }, repetition: "model-default" },
      sweet: { diversity: { driver: "temperature", value: 0.82 }, repetition: "light" },
    });
  });

  it("keeps built-in style ids mapped to the existing markdown files", () => {
    expect(STYLE_FILE_BY_ID).toEqual({
      default: "01_default.md",
      lively: "02_lively.md",
      healing: "03_healing.md",
      focused: "04_focused.md",
      sweet: "05_sweet.md",
    });
  });

  it("normalizes malformed custom input without allowing two diversity drivers", () => {
    expect(normalizeCustomStyleConfig({ diversity: { driver: "top-p", value: 9 }, repetition: "bad" }))
      .toEqual({ diversity: { driver: "top-p", value: 1 }, repetition: "model-default" });
    expect(normalizeCustomStyleConfig(null)).toEqual(DEFAULT_CUSTOM_STYLE);
  });

  it.each(["temperature", "top-p"] as const)(
    "falls back malformed %s values to model default",
    (driver) => {
      expect(normalizeCustomStyleConfig({ diversity: { driver } }).diversity)
        .toEqual({ driver: "model-default" });
      expect(normalizeCustomStyleConfig({ diversity: { driver, value: "1" } }).diversity)
        .toEqual({ driver: "model-default" });
      expect(normalizeCustomStyleConfig({ diversity: { driver, value: Number.NaN } }).diversity)
        .toEqual({ driver: "model-default" });
      expect(normalizeCustomStyleConfig({ diversity: { driver, value: Number.POSITIVE_INFINITY } }).diversity)
        .toEqual({ driver: "model-default" });
      expect(normalizeCustomStyleConfig({ diversity: { driver, value: Number.NEGATIVE_INFINITY } }).diversity)
        .toEqual({ driver: "model-default" });
    },
  );

  it("uses the custom config only for custom style", () => {
    const custom = { diversity: { driver: "temperature" as const, value: 1.1 }, repetition: "strong" as const };
    expect(resolveStylePreference("custom", custom)).toEqual(custom);
    expect(resolveStylePreference("default", custom)).toEqual(BUILT_IN_STYLE_PRESETS.default);
  });
});
