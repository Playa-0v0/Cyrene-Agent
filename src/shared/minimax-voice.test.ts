import { describe, expect, it } from "vitest";
import {
  buildMiniMaxErrorMessage,
  createUniqueMiniMaxVoiceId,
  validateMiniMaxVoiceId,
} from "./minimax-voice";

describe("MiniMax 音色 ID", () => {
  it("拒绝不符合官方规则的音色 ID", () => {
    expect(validateMiniMaxVoiceId("cyrene")).toContain("8 到 256");
    expect(validateMiniMaxVoiceId("1cyrene_voice")).toContain("英文字母");
    expect(validateMiniMaxVoiceId("cyrene_voice_")).toContain("不能是 - 或 _");
    expect(validateMiniMaxVoiceId("cyrene voice")).toContain("仅能包含");
  });

  it("生成符合官方规则且带随机后缀的建议 ID", () => {
    const voiceId = createUniqueMiniMaxVoiceId(() => 0.123456789, new Date("2026-08-28T10:20:30Z"));

    expect(voiceId).toMatch(/^cyrene-voice-20260828-102030-[a-z0-9]+$/);
    expect(validateMiniMaxVoiceId(voiceId)).toBeNull();
  });
});

describe("MiniMax 错误码说明", () => {
  it("将 2039 翻译为可执行的重复音色 ID 提示", () => {
    expect(buildMiniMaxErrorMessage(2039)).toBe(
      "音色 ID 已存在。请使用一个新的音色 ID 后再试（错误码 2039）。",
    );
  });

  it("保留未知错误的服务端说明和错误码", () => {
    expect(buildMiniMaxErrorMessage(2999, "service detail")).toBe(
      "MiniMax 请求失败：service detail（错误码 2999）。",
    );
  });

  it("在有追踪编号时附带 trace_id", () => {
    expect(buildMiniMaxErrorMessage(2039, undefined, "trace-abc")).toBe(
      "音色 ID 已存在。请使用一个新的音色 ID 后再试（错误码 2039；trace_id trace-abc）。",
    );
  });
});
