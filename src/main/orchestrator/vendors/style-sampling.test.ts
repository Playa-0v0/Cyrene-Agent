import { describe, expect, it } from "vitest";
import type { StyleSamplingPreference } from "../../../shared/style-sampling";
import { resolveApprovedStyleSampling } from "./style-sampling";

describe("resolveApprovedStyleSampling", () => {
  const lively = {
    diversity: { driver: "temperature" as const, value: 0.9 },
    repetition: "light" as const,
  };

  it("maps OpenAI light repetition to frequency penalty", () => {
    expect(resolveApprovedStyleSampling({
      providerId: "chatgpt",
      model: "gpt-4o",
      reasoning: { mode: "off" },
      preference: lively,
    })).toEqual({ temperature: 0.9, frequencyPenalty: 0.2 });
  });

  it("maps Qwen light repetition to multiplicative penalty", () => {
    expect(resolveApprovedStyleSampling({
      providerId: "qwen",
      model: "qwen-max",
      reasoning: { mode: "off" },
      preference: lively,
    })).toEqual({ temperature: 0.9, repetitionPenalty: 1.05 });
  });

  it.each([
    ["claude", "claude-sonnet-5"],
    ["kimi", "kimi-k2.6"],
    ["volcengine", "ark-code-latest"],
    ["unknown", "anything"],
  ])("omits unsupported sampling for %s", (providerId, model) => {
    expect(resolveApprovedStyleSampling({
      providerId,
      model,
      reasoning: { mode: "auto" },
      preference: lively,
    })).toEqual({});
  });

  it("omits DeepSeek sampling in thinking mode", () => {
    expect(resolveApprovedStyleSampling({
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoning: { mode: "on" },
      preference: lively,
    })).toEqual({});
  });

  it("allows DeepSeek diversity when thinking is explicitly off", () => {
    expect(resolveApprovedStyleSampling({
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      reasoning: { mode: "off" },
      preference: lively,
    })).toEqual({ temperature: 0.9 });
  });

  it("never sends temperature and topP together", () => {
    const result = resolveApprovedStyleSampling({
      providerId: "qwen",
      model: "qwen-max",
      reasoning: { mode: "off" },
      preference: {
        diversity: { driver: "top-p", value: 0.8 },
        repetition: "model-default",
      },
    });

    expect(result).toEqual({ topP: 0.8 });
    expect(result).not.toHaveProperty("temperature");
  });

  it.each([
    ["minimax", "MiniMax-M3", "auto"],
    ["minimax", "MiniMax-M2.7", "on"],
    ["glm", "glm-4.7", "auto"],
    ["glm", "glm-5.2", "on"],
  ] as const)("allows diversity only for known %s model %s", (providerId, model, mode) => {
    expect(resolveApprovedStyleSampling({
      providerId,
      model,
      reasoning: { mode },
      preference: lively,
    })).toEqual({ temperature: 0.9 });
  });

  it.each([
    ["off", { temperature: 0.9 }],
    ["auto", {}],
    ["on", {}],
  ] as const)("gates MiMo diversity when reasoning is %s", (mode, expected) => {
    expect(resolveApprovedStyleSampling({
      providerId: "mimo",
      model: "mimo-v2.5-pro",
      reasoning: { mode },
      preference: lively,
    })).toEqual(expected);
  });

  it("clamps Qwen temperature 2 to 1.99", () => {
    expect(resolveApprovedStyleSampling({
      providerId: "qwen",
      model: "qwen-max",
      reasoning: { mode: "auto" },
      preference: {
        diversity: { driver: "temperature", value: 2 },
        repetition: "model-default",
      },
    })).toEqual({ temperature: 1.99 });
  });

  it.each([
    ["model-default", {}],
    ["medium", { frequencyPenalty: 0.5 }],
    ["strong", { frequencyPenalty: 0.8 }],
  ] as const)("maps OpenAI repetition level %s", (repetition, expected) => {
    const preference: StyleSamplingPreference = {
      diversity: { driver: "model-default" },
      repetition,
    };
    expect(resolveApprovedStyleSampling({
      providerId: "chatgpt",
      model: "gpt-4.1-mini",
      reasoning: { mode: "auto" },
      preference,
    })).toEqual(expected);
  });

  it.each([
    ["model-default", {}],
    ["medium", { repetitionPenalty: 1.1 }],
    ["strong", { repetitionPenalty: 1.18 }],
  ] as const)("maps Qwen repetition level %s", (repetition, expected) => {
    const preference: StyleSamplingPreference = {
      diversity: { driver: "model-default" },
      repetition,
    };
    expect(resolveApprovedStyleSampling({
      providerId: "qwen",
      model: "qwen-plus",
      reasoning: { mode: "auto" },
      preference,
    })).toEqual(expected);
  });

  it.each([
    ["chatgpt", "o4-mini"],
    ["chatgpt", "gpt-5"],
    ["chatgpt", "gpt-4oops"],
    ["chatgpt", "future-model"],
    ["qwen", "unknown-qwen"],
    ["minimax", "MiniMax-M4"],
    ["glm", "glm-6"],
    ["deepseek", "deepseek-v3"],
    ["mimo", "mimo-v2.6"],
  ])("conservatively omits unknown or unsafe model %s/%s", (providerId, model) => {
    expect(resolveApprovedStyleSampling({
      providerId,
      model,
      reasoning: { mode: "off" },
      preference: lively,
    })).toEqual({});
  });

  it.each([
    ["chatgpt", "gpt-4.999-new"],
    ["chatgpt", "gpt-4o-preview"],
    ["chatgpt", "gpt-4.1-mini-next"],
    ["qwen", "qwen3-future"],
    ["qwen", "qwen-max-future"],
    ["minimax", "MiniMax-M3-next"],
    ["minimax", "MiniMax-M2.7-next"],
    ["glm", "glm-5-future"],
    ["glm", "glm-5.2-next"],
    ["deepseek", "deepseek-v4-pro-next"],
    ["mimo", "mimo-v2.5-tts-voiceclone"],
    ["mimo", "mimo-v2.5-pro-next"],
  ])("rejects non-allowlisted prefix variant %s/%s", (providerId, model) => {
    expect(resolveApprovedStyleSampling({
      providerId,
      model,
      reasoning: { mode: "off" },
      preference: lively,
    })).toEqual({});
  });

  it.each([
    ["chatgpt", "GPT-4O-MINI"],
    ["qwen", "QWEN-TURBO"],
    ["minimax", "minimax-m2.5"],
    ["glm", "GLM-5-TURBO"],
    ["deepseek", "DEEPSEEK-V4-FLASH"],
    ["mimo", "MIMO-V2.5-PRO"],
  ])("matches exact allowlisted model case-insensitively for %s/%s", (providerId, model) => {
    expect(resolveApprovedStyleSampling({
      providerId,
      model,
      reasoning: { mode: "off" },
      preference: lively,
    })).toEqual({ temperature: 0.9, ...(
      providerId === "chatgpt"
        ? { frequencyPenalty: 0.2 }
        : providerId === "qwen"
          ? { repetitionPenalty: 1.05 }
          : {}
    ) });
  });

  it("omits DeepSeek diversity when reasoning mode is auto", () => {
    expect(resolveApprovedStyleSampling({
      providerId: "deepseek",
      model: "deepseek-v4",
      reasoning: { mode: "auto" },
      preference: lively,
    })).toEqual({});
  });
});
