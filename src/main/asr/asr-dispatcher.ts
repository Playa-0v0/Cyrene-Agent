import type { AsrConfig } from "./asr-config";
import { LocalAsrStream, DEFAULT_LOCAL_ASR_URL } from "./local-asr-engine";
import { MosslandAsrStream } from "./mossland-asr-engine";
import { VolcanoAsrStream } from "./volcano-asr-engine";

export interface AsrStreamSession {
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
  stop(): void | Promise<string>;
}

export function createAsrStream(
  config: AsrConfig,
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
): AsrStreamSession {
  if (config.engine === "mossland") {
    return new MosslandAsrStream(config.apiKey, onFinal);
  }

  if (config.engine === "local") {
    return new LocalAsrStream(config.baseUrl ?? DEFAULT_LOCAL_ASR_URL, onFinal);
  }

  const stream = new VolcanoAsrStream(onPartial, onFinal);
  return {
    start: () => stream.start(
      config.appKey,
      config.accessKeyId,
      config.accessKeySecret,
      config.language,
    ),
    sendAudio: (frame) => stream.sendAudio(frame),
    stop: () => stream.stop(),
  };
}
