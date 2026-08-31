import { encode, getWavFileInfo, isSilk, isWav } from "silk-wasm";

const ALLOWED_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);

export const WECHAT_VOICE_ENCODE_TYPE_SILK = 6;

export type WechatVoiceSourceFormat = "wav" | "pcm_s16le";

export interface EncodeWechatVoiceOptions {
  format?: WechatVoiceSourceFormat;
  sampleRate?: number;
}

export interface EncodedWechatVoice {
  data: Buffer;
  durationMs: number;
  sampleRate: number;
  encodeType: typeof WECHAT_VOICE_ENCODE_TYPE_SILK;
}

function asUint8Array(data: Buffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function assertAllowedSampleRate(sampleRate: number): void {
  if (!Number.isInteger(sampleRate) || !ALLOWED_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(`Unsupported WeChat voice sample rate: ${sampleRate}`);
  }
}

function resolveWavSampleRate(data: Uint8Array): number {
  const info = getWavFileInfo(data);
  if (info.fmt.formatCode !== 1) {
    throw new Error(`Unsupported WAV format code for WeChat voice: ${info.fmt.formatCode}`);
  }
  if (info.fmt.numberOfChannels !== 1) {
    throw new Error(`WeChat voice WAV must be mono, got ${info.fmt.numberOfChannels} channels`);
  }
  if (info.fmt.bitsPerSample !== 16) {
    throw new Error(`WeChat voice WAV must be 16-bit PCM, got ${info.fmt.bitsPerSample}-bit`);
  }
  assertAllowedSampleRate(info.fmt.sampleRate);
  return info.fmt.sampleRate;
}

export async function encodeWechatVoiceSilk(
  input: Buffer | Uint8Array,
  options: EncodeWechatVoiceOptions = {},
): Promise<EncodedWechatVoice> {
  const data = asUint8Array(input);
  if (data.length === 0) throw new Error("WeChat voice input is empty");
  if (isSilk(data)) throw new Error("WeChat voice input is already SILK");

  const format = options.format ?? (isWav(data) ? "wav" : "pcm_s16le");
  let sampleRate: number;
  let encodeSampleRate: number;
  if (format === "wav") {
    if (!isWav(data)) throw new Error("WeChat voice input is not a WAV file");
    sampleRate = resolveWavSampleRate(data);
    encodeSampleRate = 0;
  } else {
    if (typeof options.sampleRate !== "number") {
      throw new Error("WeChat voice PCM input requires sampleRate");
    }
    sampleRate = options.sampleRate;
    assertAllowedSampleRate(sampleRate);
    encodeSampleRate = sampleRate;
  }

  const result = await encode(data, encodeSampleRate);
  if (!result.data.length) throw new Error("WeChat voice SILK encoding returned empty data");

  return {
    data: Buffer.from(result.data),
    durationMs: result.duration,
    sampleRate,
    encodeType: WECHAT_VOICE_ENCODE_TYPE_SILK,
  };
}
