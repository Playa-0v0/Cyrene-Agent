import { getDuration, isSilk } from "silk-wasm";
import { describe, expect, it } from "vitest";
import { encodeWechatVoiceSilk, WECHAT_VOICE_ENCODE_TYPE_SILK } from "./wechat-voice-encoding";

function makeSilentPcm(durationMs: number, sampleRate: number, channels = 1): Buffer {
  const samples = Math.max(1, Math.floor(sampleRate * durationMs / 1000));
  return Buffer.alloc(samples * channels * 2);
}

function makeWav(data: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("encodeWechatVoiceSilk", () => {
  it("encodes mono 16-bit WAV into SILK with duration metadata", async () => {
    const wav = makeWav(makeSilentPcm(40, 24000), 24000);

    const result = await encodeWechatVoiceSilk(wav);

    expect(isSilk(result.data)).toBe(true);
    expect(result.durationMs).toBe(40);
    expect(getDuration(result.data)).toBe(40);
    expect(result.sampleRate).toBe(24000);
    expect(result.encodeType).toBe(WECHAT_VOICE_ENCODE_TYPE_SILK);
  });

  it("encodes mono pcm_s16le when sampleRate is provided", async () => {
    const pcm = makeSilentPcm(60, 16000);

    const result = await encodeWechatVoiceSilk(pcm, { format: "pcm_s16le", sampleRate: 16000 });

    expect(isSilk(result.data)).toBe(true);
    expect(result.durationMs).toBe(60);
    expect(result.sampleRate).toBe(16000);
  });

  it("rejects PCM input without a sample rate", async () => {
    await expect(encodeWechatVoiceSilk(Buffer.from([0, 1, 2, 3]), { format: "pcm_s16le" }))
      .rejects.toThrow("sampleRate");
  });

  it("rejects unsupported WAV channel layouts", async () => {
    const wav = makeWav(makeSilentPcm(20, 24000, 2), 24000, 2);

    await expect(encodeWechatVoiceSilk(wav)).rejects.toThrow("mono");
  });
});
