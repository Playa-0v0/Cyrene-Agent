import * as os from "node:os";
import * as path from "node:path";

const MODEL_ID = "Xenova/whisper-base";
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;
let pipelinePromise: Promise<any> | null = null;

export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = Math.floor(pcm.length / 2);
  const audio = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    audio[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return audio;
}

async function getPipeline(onProgress?: (message: string) => void): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await importEsm("@xenova/transformers");
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      env.useBrowserCache = false;
      env.cacheDir = path.join(os.homedir(), ".cache", "huggingface");
      onProgress?.("首次準備離線語音模型，下載完成後會自動快取");
      return pipeline("automatic-speech-recognition", MODEL_ID, {
        quantized: true,
        progress_callback: (progress: any) => {
          if (progress?.status === "ready") {
            onProgress?.("離線語音模型已就緒");
          }
        },
      });
    })().catch((error) => {
      pipelinePromise = null;
      throw error;
    });
  }
  return pipelinePromise;
}

export async function transcribeOfflineWhisper(
  pcm: Buffer,
  language: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const recognizer = await getPipeline(onProgress);
  const audio = pcm16ToFloat32(pcm);
  const result = await recognizer(audio, {
    language: language === "zh" ? "chinese" : "english",
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
  }) as { text?: string };
  return result.text?.trim() ?? "";
}
