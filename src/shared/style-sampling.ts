export const STYLE_IDS = ["default", "lively", "healing", "focused", "sweet", "custom"] as const;

export type StyleId = typeof STYLE_IDS[number];
export type RepetitionLevel = "model-default" | "light" | "medium" | "strong";
export type DiversityPreference =
  | { driver: "model-default" }
  | { driver: "temperature"; value: number }
  | { driver: "top-p"; value: number };

export interface CustomStyleConfig {
  diversity: DiversityPreference;
  repetition: RepetitionLevel;
}

export type StyleSamplingPreference = CustomStyleConfig;

export const DEFAULT_CUSTOM_STYLE: CustomStyleConfig = {
  diversity: { driver: "model-default" },
  repetition: "model-default",
};

export const BUILT_IN_STYLE_PRESETS = {
  default: { diversity: { driver: "temperature", value: 0.65 }, repetition: "model-default" },
  lively: { diversity: { driver: "temperature", value: 0.90 }, repetition: "light" },
  healing: { diversity: { driver: "temperature", value: 0.55 }, repetition: "model-default" },
  focused: { diversity: { driver: "temperature", value: 0.40 }, repetition: "model-default" },
  sweet: { diversity: { driver: "temperature", value: 0.82 }, repetition: "light" },
} as const satisfies Record<Exclude<StyleId, "custom">, StyleSamplingPreference>;

export const STYLE_FILE_BY_ID = {
  default: "01_default.md",
  lively: "02_lively.md",
  healing: "03_healing.md",
  focused: "04_focused.md",
  sweet: "05_sweet.md",
} as const satisfies Record<Exclude<StyleId, "custom">, string>;

const REPETITION_LEVELS: readonly RepetitionLevel[] = ["model-default", "light", "medium", "strong"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeStyleId(value: unknown): StyleId {
  return typeof value === "string" && (STYLE_IDS as readonly string[]).includes(value)
    ? value as StyleId
    : "default";
}

export function normalizeCustomStyleConfig(value: unknown): CustomStyleConfig {
  if (!isRecord(value)) {
    return DEFAULT_CUSTOM_STYLE;
  }

  const diversity = value.diversity;
  let normalizedDiversity: DiversityPreference = { driver: "model-default" };

  if (isRecord(diversity)) {
    if (
      diversity.driver === "temperature"
      && typeof diversity.value === "number"
      && Number.isFinite(diversity.value)
    ) {
      normalizedDiversity = {
        driver: "temperature",
        value: clampNumber(diversity.value, 0, 2),
      };
    } else if (
      diversity.driver === "top-p"
      && typeof diversity.value === "number"
      && Number.isFinite(diversity.value)
    ) {
      normalizedDiversity = {
        driver: "top-p",
        value: clampNumber(diversity.value, 0, 1),
      };
    }
  }

  const repetition = REPETITION_LEVELS.includes(value.repetition as RepetitionLevel)
    ? value.repetition as RepetitionLevel
    : "model-default";

  return { diversity: normalizedDiversity, repetition };
}

export function resolveStylePreference(
  styleId: StyleId,
  customStyle: unknown,
): StyleSamplingPreference {
  return styleId === "custom"
    ? normalizeCustomStyleConfig(customStyle)
    : BUILT_IN_STYLE_PRESETS[styleId];
}
