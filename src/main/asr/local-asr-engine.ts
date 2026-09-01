import { encodePcm16MonoWav } from "./mossland-asr-engine";

/** 本地 FunASR 服务默认地址（见配套技能 cyrene-local-asr / start_asr.bat）。 */
export const DEFAULT_LOCAL_ASR_URL = "http://127.0.0.1:8328";
const PROBE_TIMEOUT_MS = 2_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

async function transcribeLocal(baseUrl: string, wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("model", "moss-transcribe");
  form.append("response_format", "json");
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch {
    throw new Error("本地 ASR 服务未启动：请先启动 127.0.0.1:8328 的 FunASR 服务再通话");
  }
  if (!response.ok) {
    throw new Error(`本地 ASR 转写失败 (HTTP ${response.status})`);
  }

  const data = await response.json() as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("本地 ASR 转写失败：服务端未返回 text");
  }
  return data.text.trim();
}

/**
 * 本地 FunASR 批量转写会话：缓存一轮 PCM，stop 时上传 WAV 并返回完整文本。
 *
 * 配套服务端：asr_server.py（cyrene-local-asr 技能，Flask，端口 8328），
 * 提供 GET /status 存活探测与 POST /v1/audio/transcriptions 转写。
 */
export class LocalAsrStream {
  private readonly frames: Buffer[] = [];
  private stopPromise: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly onFinal: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    // 本地服务不需要鉴权，先探测一下服务是否存活，给出友好报错
    try {
      const resp = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error("status " + resp.status);
      }
    } catch {
      throw new Error("本地 ASR 服务未启动：请先启动 127.0.0.1:8328 的 FunASR 服务再通话");
    }
  }

  sendAudio(pcmFrame: Buffer): void {
    if (this.stopPromise || pcmFrame.length === 0) return;
    this.frames.push(Buffer.from(pcmFrame));
  }

  stop(): Promise<string> {
    if (!this.stopPromise) {
      this.stopPromise = this.finish();
    }
    return this.stopPromise;
  }

  private async finish(): Promise<string> {
    if (this.frames.length === 0) return "";
    const text = await transcribeLocal(this.baseUrl, encodePcm16MonoWav(Buffer.concat(this.frames)));
    if (text) this.onFinal(text);
    return text;
  }
}
