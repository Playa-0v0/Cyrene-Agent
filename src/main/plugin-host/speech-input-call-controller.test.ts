import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechInputCallController } from "./speech-input-call-controller";

const mocks = vi.hoisted(() => ({
  claimExternalSpeechInput: vi.fn(),
  submitExternalText: vi.fn(),
  releaseExternalSpeechInput: vi.fn(),
  onCallEnded: vi.fn(() => () => undefined),
}));

vi.mock("../call/call-manager", () => ({
  claimExternalSpeechInput: mocks.claimExternalSpeechInput,
  submitExternalText: mocks.submitExternalText,
  releaseExternalSpeechInput: mocks.releaseExternalSpeechInput,
  onCallEnded: mocks.onCallEnded,
}));

describe("createSpeechInputCallController", () => {
  beforeEach(() => {
    mocks.claimExternalSpeechInput.mockReset();
    mocks.submitExternalText.mockReset();
    mocks.releaseExternalSpeechInput.mockReset();
    mocks.onCallEnded.mockReset().mockReturnValue(() => undefined);
  });

  it("接管结果原样透传：成功返回代次，无通话返回 null", () => {
    const controller = createSpeechInputCallController();
    mocks.claimExternalSpeechInput.mockReturnValueOnce({ callGeneration: 3 });
    expect(controller.claimExternalInput()).toEqual({ callGeneration: 3 });
    mocks.claimExternalSpeechInput.mockReturnValueOnce(null);
    expect(controller.claimExternalInput()).toBeNull();
  });

  it("提交成功不抛错", () => {
    const controller = createSpeechInputCallController();
    mocks.submitExternalText.mockReturnValueOnce({ ok: true });
    expect(() => controller.commitExternalText(3, "你好")).not.toThrow();
    expect(mocks.submitExternalText).toHaveBeenCalledWith(3, "你好");
  });

  it("提交失败原因映射为稳定错误码", () => {
    const controller = createSpeechInputCallController();
    const cases: Array<[string, string]> = [
      ["no-call", "E_NOT_FOUND"],
      ["stale-call", "E_NOT_FOUND"],
      ["busy", "E_SPEECH_INPUT_BUSY"],
      ["empty-text", "E_INVALID_ARGUMENT"],
      ["not-owner", "E_INTERNAL"],
    ];
    for (const [reason, code] of cases) {
      mocks.submitExternalText.mockReturnValueOnce({ ok: false, reason });
      expect(() => controller.commitExternalText(1, "文本")).toThrowError(
        expect.objectContaining({ code }),
      );
    }
  });

  it("释放与通话结束监听原样委托", () => {
    const controller = createSpeechInputCallController();
    controller.releaseExternalInput(5);
    expect(mocks.releaseExternalSpeechInput).toHaveBeenCalledWith(5);

    const listener = (generation: number) => generation;
    const unsubscribe = () => undefined;
    mocks.onCallEnded.mockReturnValueOnce(unsubscribe);
    expect(controller.onCallEnded(listener)).toBe(unsubscribe);
    expect(mocks.onCallEnded).toHaveBeenCalledWith(listener);
  });
});
