import { describe, expect, it, vi } from "vitest";
import {
  calibratedNoiseFloor,
  callAudioMimeType,
  collectRecognitionText,
  keepPcmWorkletAlive,
  isFatalSpeechRecognitionError,
  speechOnsetThreshold,
  speechReleaseThreshold,
  timeDomainRms,
} from "./audio-utils";

describe("call audio helpers", () => {
  it("keeps the PCM worklet connected to the live audio graph", () => {
    const connect = vi.fn();
    const destination = {} as AudioNode;

    keepPcmWorkletAlive({ connect } as unknown as Pick<AudioNode, "connect">, destination);

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(destination);
  });

  it.each([
    ["wav", "audio/wav"],
    ["mp3", "audio/mpeg"],
  ] as const)("maps %s TTS audio to %s", (format, expected) => {
    expect(callAudioMimeType(format)).toBe(expected);
  });

  it("keeps earlier final Web Speech results when a later interim result arrives", () => {
    const results = [
      { isFinal: true, 0: { transcript: "你好，" } },
      { isFinal: true, 0: { transcript: "昔漣。" } },
      { isFinal: false, 0: { transcript: "今天好嗎" } },
    ];

    expect(collectRecognitionText(results)).toEqual({
      final: "你好，昔漣。",
      interim: "今天好嗎",
      combined: "你好，昔漣。今天好嗎",
    });
  });

  it("does not let loud startup spikes dominate noise calibration", () => {
    const floor = calibratedNoiseFloor([0.021, 0.019, 0.022, 0.2, 0.31, 0.02, 0.018]);
    expect(floor).toBeCloseTo(0.02, 3);
    expect(speechOnsetThreshold(floor)).toBeGreaterThan(floor * 1.7);
    expect(speechOnsetThreshold(floor)).toBeLessThan(0.05);
    expect(speechReleaseThreshold(floor)).toBeLessThan(speechOnsetThreshold(floor));
  });

  it("calculates normalized RMS from time-domain microphone samples", () => {
    expect(timeDomainRms(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(timeDomainRms(new Uint8Array([0, 255]))).toBeGreaterThan(0.99);
  });

  it("stops retrying fatal Web Speech errors", () => {
    expect(isFatalSpeechRecognitionError("network")).toBe(true);
    expect(isFatalSpeechRecognitionError("language-not-supported")).toBe(true);
    expect(isFatalSpeechRecognitionError("no-speech")).toBe(false);
  });
});
