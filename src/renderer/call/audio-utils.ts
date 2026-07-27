export type CallAudioFormat = "wav" | "mp3";

/**
 * AudioWorklet processors are only pulled while they belong to a live Web Audio graph.
 * The PCM processor writes no output, so this connection keeps capture alive silently.
 */
export function keepPcmWorkletAlive(
  worklet: Pick<AudioNode, "connect">,
  destination: AudioNode,
): void {
  worklet.connect(destination);
}

export function callAudioMimeType(format: CallAudioFormat): string {
  return format === "wav" ? "audio/wav" : "audio/mpeg";
}

/** Normalized time-domain RMS (0..1), more stable for VAD than FFT-bin averages. */
export function timeDomainRms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    squareSum += normalized * normalized;
  }
  return Math.sqrt(squareSum / samples.length);
}

/** Use a low percentile so startup clicks or a cough do not poison noise calibration. */
export function calibratedNoiseFloor(samples: readonly number[]): number {
  if (samples.length === 0) return 0.008;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.35));
  return Math.max(0.003, Math.min(0.12, sorted[index]));
}

export function speechOnsetThreshold(noiseFloor: number): number {
  return Math.max(0.018, Math.min(0.22, Math.max(noiseFloor * 1.8, noiseFloor + 0.012)));
}

export function speechReleaseThreshold(noiseFloor: number): number {
  return Math.max(0.012, Math.min(0.2, Math.max(noiseFloor * 1.65, noiseFloor + 0.007)));
}

export function isFatalSpeechRecognitionError(error: string): boolean {
  return ["network", "not-allowed", "service-not-allowed", "language-not-supported"].includes(error);
}

type RecognitionAlternative = { transcript?: string };
type RecognitionResult = { isFinal: boolean; 0?: RecognitionAlternative };

/** Rebuild the complete continuous-recognition text, including earlier final results. */
export function collectRecognitionText(results: ArrayLike<RecognitionResult>): {
  final: string;
  interim: string;
  combined: string;
} {
  let final = "";
  let interim = "";
  for (let i = 0; i < results.length; i += 1) {
    const transcript = results[i]?.[0]?.transcript ?? "";
    if (results[i]?.isFinal) final += transcript;
    else interim += transcript;
  }
  return { final, interim, combined: final + interim };
}
