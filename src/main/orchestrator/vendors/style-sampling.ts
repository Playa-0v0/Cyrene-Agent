import type { ReasoningPreference } from "../../../shared/reasoning";
import type {
  RepetitionLevel,
  StyleSamplingPreference,
} from "../../../shared/style-sampling";

export interface ApprovedStyleSampling {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

interface ResolveStyleSamplingInput {
  providerId: string;
  model: string;
  reasoning: ReasoningPreference;
  preference: StyleSamplingPreference;
}

interface ModelSamplingRule {
  providerId: string;
  modelPattern: RegExp;
  diversity: boolean;
  repetition?: "openai" | "qwen";
  requiresReasoningOff?: boolean;
  maximumTemperature?: number;
}

const OPENAI_REPETITION = { light: 0.2, medium: 0.5, strong: 0.8 } as const;
const QWEN_REPETITION = { light: 1.05, medium: 1.10, strong: 1.18 } as const;

const MODEL_SAMPLING_RULES: readonly ModelSamplingRule[] = [
  {
    providerId: "chatgpt",
    modelPattern: /^(?:gpt-4o(?:-mini)?|gpt-4\.1(?:-(?:mini|nano))?)$/i,
    diversity: true,
    repetition: "openai",
  },
  {
    providerId: "qwen",
    modelPattern: /^qwen-(?:max|plus|turbo)$/i,
    diversity: true,
    repetition: "qwen",
    maximumTemperature: 1.99,
  },
  {
    providerId: "minimax",
    modelPattern: /^MiniMax-(?:M3|M2\.(?:7|5))$/i,
    diversity: true,
  },
  {
    providerId: "glm",
    modelPattern: /^glm-(?:5\.[12]|5-turbo|4\.7)$/i,
    diversity: true,
  },
  {
    providerId: "deepseek",
    modelPattern: /^deepseek-v4-(?:pro|flash)$/i,
    diversity: true,
    requiresReasoningOff: true,
  },
  {
    providerId: "mimo",
    modelPattern: /^mimo-v2\.5-pro$/i,
    diversity: true,
    requiresReasoningOff: true,
  },
];

function resolveDiversity(
  preference: StyleSamplingPreference,
  rule: ModelSamplingRule,
): ApprovedStyleSampling {
  if (!rule.diversity || preference.diversity.driver === "model-default") {
    return {};
  }

  if (preference.diversity.driver === "top-p") {
    return { topP: preference.diversity.value };
  }

  const maximum = rule.maximumTemperature ?? preference.diversity.value;
  return { temperature: Math.min(preference.diversity.value, maximum) };
}

function repetitionValue<T extends number>(
  level: RepetitionLevel,
  mapping: Readonly<Record<Exclude<RepetitionLevel, "model-default">, T>>,
): T | undefined {
  return level === "model-default" ? undefined : mapping[level];
}

export function resolveApprovedStyleSampling({
  providerId,
  model,
  reasoning,
  preference,
}: ResolveStyleSamplingInput): ApprovedStyleSampling {
  const rule = MODEL_SAMPLING_RULES.find(candidate => (
    candidate.providerId === providerId && candidate.modelPattern.test(model)
  ));

  if (!rule || (rule.requiresReasoningOff && reasoning.mode !== "off")) {
    return {};
  }

  const approved = resolveDiversity(preference, rule);

  if (rule.repetition === "openai") {
    const frequencyPenalty = repetitionValue(preference.repetition, OPENAI_REPETITION);
    return frequencyPenalty === undefined ? approved : { ...approved, frequencyPenalty };
  }

  if (rule.repetition === "qwen") {
    const repetitionPenalty = repetitionValue(preference.repetition, QWEN_REPETITION);
    return repetitionPenalty === undefined ? approved : { ...approved, repetitionPenalty };
  }

  return approved;
}
