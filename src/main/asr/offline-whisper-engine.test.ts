import { describe, expect, it } from "vitest";
import { pcm16ToFloat32 } from "./offline-whisper-engine";

describe("offline Whisper audio conversion", () => {
  it("converts little-endian PCM16 samples to normalized floats", () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(-32768, 0);
    pcm.writeInt16LE(0, 2);
    pcm.writeInt16LE(16384, 4);
    pcm.writeInt16LE(32767, 6);

    const audio = pcm16ToFloat32(pcm);
    expect(audio[0]).toBe(-1);
    expect(audio[1]).toBe(0);
    expect(audio[2]).toBeCloseTo(16384 / 32767, 6);
    expect(audio[3]).toBe(1);
  });
});
