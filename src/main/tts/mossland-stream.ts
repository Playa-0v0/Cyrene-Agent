export interface MosslandPcmStreamInfo {
  taskId?: string;
  format: "pcm";
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface MosslandSseHandlers {
  onAudio?: (chunk: Buffer) => void;
}

type MosslandSseEvent = {
  type?: string;
  task_id?: string;
  format?: string;
  sample_rate?: number;
  channels?: number;
  bit_depth?: number;
  audio?: string;
  error?: { code?: string; message?: string };
};

function readData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length > 0 ? data.join("\n") : null;
}

function parseEvent(frame: string): MosslandSseEvent | null {
  const data = readData(frame);
  if (data === null || !data.trim()) return null;
  try {
    return JSON.parse(data) as MosslandSseEvent;
  } catch {
    throw new Error("Mossland 流式合成失败：收到无法解析的 SSE 数据");
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Mossland 流式合成失败：speech.created 的 ${field} 无效`);
  }
}

function decodeBase64Audio(value: string): Buffer {
  const audio = Buffer.from(value, "base64");
  const canonicalInput = value.replace(/=+$/, "");
  const canonicalOutput = audio.toString("base64").replace(/=+$/, "");
  if (!canonicalInput || canonicalInput !== canonicalOutput) {
    throw new Error("Mossland 流式合成失败：音频分片不是有效的 Base64 数据");
  }
  return audio;
}

/**
 * 消费 Mossland 的 SSE 流。只有 speech.audio.done 才表示成功；单纯 EOF
 * 可能是中途断连，不能被当作一段完整音频。
 */
export async function consumeMosslandSse(
  response: Response,
  handlers: MosslandSseHandlers = {},
): Promise<MosslandPcmStreamInfo> {
  if (!response.ok) {
    throw new Error(`Mossland 流式合成失败：HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Mossland 流式合成失败：响应没有可读取的数据流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let taskId: string | undefined;
  let streamInfo: MosslandPcmStreamInfo | undefined;
  let done = false;

  const handleFrame = (frame: string): void => {
    const event = parseEvent(frame);
    if (!event) return;

    switch (event.type) {
      case "task.created":
        if (typeof event.task_id === "string" && event.task_id) taskId = event.task_id;
        return;
      case "speech.created": {
        if (event.format !== "pcm") {
          throw new Error("Mossland 流式合成失败：speech.created 的 format 必须是 pcm");
        }
        assertPositiveInteger(event.sample_rate, "sample_rate");
        assertPositiveInteger(event.channels, "channels");
        assertPositiveInteger(event.bit_depth, "bit_depth");
        if (event.bit_depth % 8 !== 0) {
          throw new Error("Mossland 流式合成失败：speech.created 的 bit_depth 必须能被 8 整除");
        }
        streamInfo = {
          taskId,
          format: "pcm",
          sampleRate: event.sample_rate,
          channels: event.channels,
          bitDepth: event.bit_depth,
        };
        return;
      }
      case "speech.audio.delta":
        if (!streamInfo) {
          throw new Error("Mossland 流式合成失败：在 speech.created 前收到了音频分片");
        }
        if (event.audio) {
          const audio = decodeBase64Audio(event.audio);
          handlers.onAudio?.(audio);
        }
        return;
      case "speech.audio.done":
        if (!streamInfo) {
          throw new Error("Mossland 流式合成失败：在 speech.created 前收到了完成事件");
        }
        done = true;
        return;
      case "error": {
        const message = event.error?.message || "服务端返回流式错误";
        const code = event.error?.code ? `（${event.error.code}）` : "";
        throw new Error(`Mossland 流式合成失败：${message}${code}`);
      }
      default:
        return;
    }
  };

  try {
    while (!done) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });

      let separator = buffered.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const frame = buffered.slice(0, separator);
        const separatorLength = buffered.startsWith("\r\n\r\n", separator) ? 4 : 2;
        buffered = buffered.slice(separator + separatorLength);
        handleFrame(frame);
        if (done) break;
        separator = buffered.search(/\r?\n\r?\n/);
      }

      if (next.done) {
        if (buffered.trim()) handleFrame(buffered);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!done || !streamInfo) {
    throw new Error("Mossland 流式合成失败：连接提前结束，未收到 speech.audio.done");
  }
  return { ...streamInfo, taskId: taskId ?? streamInfo.taskId };
}
