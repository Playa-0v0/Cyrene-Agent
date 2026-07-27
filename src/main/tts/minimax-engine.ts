// MiniMax TTS 引擎
//
// 三大功能：
// 1. uploadFile — 上傳音頻文件(配音/示例)，拿 file_id
// 2. cloneVoice — 音色快速復刻，上傳 file_id + voice_id 訓練
// 3. synthesize — WebSocket 流式語音合成，返回完整音頻 buffer
//
// API 參考：https://platform.minimaxi.com/document
// 鑑權：Authorization: Bearer {API_KEY}

import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";

const BASE_URL = "https://api.minimax.io";
const WS_URL = "wss://api.minimax.io/ws/v1/t2a_v2";

// ── 上傳音頻文件 ──────────────────────────────────────────────

export interface UploadedFile {
  file_id: string;
  bytes: number;
  filename: string;
  purpose: string;
}

/**
 * 上傳音頻文件（配音 or 示例音頻），返回 file_id。
 * - purpose="voice_clone"：上傳配音（10秒~5分鐘，≤20MB）
 * - purpose="prompt_audio"：上傳示例（≤8秒，≤20MB）
 */
export async function uploadFile(
  apiKey: string,
  filePath: string,
  purpose: "voice_clone" | "prompt_audio",
): Promise<UploadedFile> {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  // 構造 multipart/form-data
  const boundary = "----CyreneTTS" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  // purpose 字段
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`,
    ),
  );

  // file 字段
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch(`${BASE_URL}/v1/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const data = (await response.json()) as {
    file?: { file_id: string; bytes: number; filename: string; purpose: string };
    base_resp?: { status_code: number; status_msg: string };
  };

  if (data.base_resp?.status_code !== 0 || !data.file) {
    throw new Error(`上傳失敗: ${data.base_resp?.status_msg ?? "未知錯誤"} (code: ${data.base_resp?.status_code})`);
  }

  return {
    file_id: String(data.file.file_id),
    bytes: data.file.bytes,
    filename: data.file.filename,
    purpose: data.file.purpose,
  };
}

// ── 音色快速復刻 ──────────────────────────────────────────────

export interface CloneVoiceOptions {
  apiKey: string;
  fileId: string;              // 配音文件的 file_id
  voiceId: string;             // 自定義音色 ID（用戶命名）
  promptAudioId?: string;      // 示例音頻 file_id（可選）
  promptText?: string;         // 示例音頻對應的文本（可選）
  text: string;                // 復刻用文本（訓練時會合成這句做對比）
  model?: string;              // 默認 speech-2.8-hd
}

export interface CloneVoiceResult {
  voiceId: string;
  audioDemo?: string;          // 試聽音頻的下載 URL（如果有）
  raw: unknown;
}

/**
 * 音色快速復刻。上傳 file_id + voice_id 後，MiniMax 訓練音色。
 * 成功後 voice_id 可用於後續 synthesize 調用。
 */
export async function cloneVoice(opts: CloneVoiceOptions): Promise<CloneVoiceResult> {
  const payload: Record<string, unknown> = {
    file_id: Number(opts.fileId),
    voice_id: opts.voiceId,
    text: opts.text,
    model: opts.model ?? "speech-2.8-hd",
  };

  if (opts.promptAudioId && opts.promptText) {
    payload.clone_prompt = {
      prompt_audio: Number(opts.promptAudioId),
      prompt_text: opts.promptText,
    };
  }

  const response = await fetch(`${BASE_URL}/v1/voice_clone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as {
    data?: { audio?: string; demo_audio?: string };
    base_resp?: { status_code: number; status_msg: string };
  };

  if (data.base_resp?.status_code !== 0) {
    throw new Error(`復刻失敗: ${data.base_resp?.status_msg ?? "未知錯誤"} (code: ${data.base_resp?.status_code})`);
  }

  return {
    voiceId: opts.voiceId,
    audioDemo: data.data?.audio ?? data.data?.demo_audio,
    raw: data,
  };
}

// ── WebSocket 流式語音合成 ────────────────────────────────────

export interface SynthesizeOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  speed?: number;        // 語速 0.5~2，默認 1
  volume?: number;       // 音量 0~2，默認 1
  pitch?: number;        // 音調 -12~12，默認 0
  model?: string;        // 默認 speech-2.8-hd
  format?: "mp3" | "wav" | "pcm";  // 默認 mp3
  sampleRate?: number;   // 默認 32000
  debugLog?: (entry: Record<string, unknown>) => void; // 本地診斷日誌（不上傳）
  /** 流式回調：每收到一段 audio chunk 就調一次（傳 base64）。不傳 = 完整合成模式。 */
  onChunk?: (chunkBase64: string) => void;
}

/**
 * WebSocket 流式語音合成。
 * 建立 WS 連接 → task_start → task_continue(發文本) → 收 hex 音頻塊 → 拼接 → 返回完整 buffer。
 * 超時 30 秒。
 */
export async function synthesize(opts: SynthesizeOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    const requestId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    let audioHexChars = 0;
    let audioChunkCount = 0;
    let resolved = false;

    const log = (entry: Record<string, unknown>) => {
      try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
    };

    log({
      phase: "request.begin",
      endpoint: WS_URL,
      textChars: Array.from(opts.text).length,
      textUtf8Bytes: Buffer.byteLength(opts.text, "utf8"),
      request: {
        task_start: {
          event: "task_start",
          model: opts.model ?? "speech-2.8-hd",
          voice_setting: {
            voice_id: opts.voiceId,
            speed: opts.speed ?? 1,
            vol: opts.volume ?? 1,
            pitch: opts.pitch ?? 0,
            english_normalization: false,
          },
          audio_setting: {
            sample_rate: opts.sampleRate ?? 32000,
            bitrate: 128000,
            format: opts.format ?? "mp3",
            channel: 1,
          },
        },
        task_continue: {
          event: "task_continue",
          text: opts.text,
        },
      },
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch { /* ignore */ }
        log({ phase: "error", error: "語音合成超時（30秒）", durationMs: Date.now() - startedAt });
        reject(new Error("語音合成超時（30秒）"));
      }
    }, 30000);

    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });

    ws.on("open", () => {
      log({ phase: "ws.open" });
      // 連接建立後等 MiniMax 回 connected_success
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          event?: string;
          data?: { audio?: string };
          is_final?: boolean;
          base_resp?: { status_code: number; status_msg: string };
        };

        // 連接成功 → 發 task_start
        if (msg.event === "connected_success") {
          log({ phase: "response.event", event: msg.event, base_resp: msg.base_resp ?? null });
          const startMsg = {
            event: "task_start",
            model: opts.model ?? "speech-2.8-hd",
            voice_setting: {
              voice_id: opts.voiceId,
              speed: opts.speed ?? 1,
              vol: opts.volume ?? 1,
              pitch: opts.pitch ?? 0,
              english_normalization: false,
            },
            audio_setting: {
              sample_rate: opts.sampleRate ?? 32000,
              bitrate: 128000,
              format: opts.format ?? "mp3",
              channel: 1,
            },
          };
          ws.send(JSON.stringify(startMsg));
          log({ phase: "request.sent", event: "task_start" });
          return;
        }

        // task 啟動成功 → 發 task_continue(發文本)
        if (msg.event === "task_started") {
          log({ phase: "response.event", event: msg.event, base_resp: msg.base_resp ?? null });
          ws.send(JSON.stringify({ event: "task_continue", text: opts.text }));
          log({ phase: "request.sent", event: "task_continue", textChars: Array.from(opts.text).length });
          return;
        }

        // 收到音頻塊 → hex 解碼拼接。音頻內容很大，只記長度，不把 hex 全量寫日誌。
        if (msg.data?.audio) {
          const chunkBuf = Buffer.from(msg.data.audio, "hex");
          audioChunks.push(chunkBuf);
          audioChunkCount += 1;
          audioHexChars += msg.data.audio.length;
          // 流式模式：每收到一塊就回調（base64）
          if (opts.onChunk) {
            try { opts.onChunk(chunkBuf.toString("base64")); } catch { /* ignore */ }
          }
          log({ phase: "response.audio_chunk", hexChars: msg.data.audio.length, chunkIndex: audioChunkCount });
        }

        // 合成完成
        if (msg.is_final) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            try { ws.send(JSON.stringify({ event: "task_finish" })); } catch { /* ignore */ }
            const audioBuffer = Buffer.concat(audioChunks);
            log({
              phase: "response.final",
              base_resp: msg.base_resp ?? null,
              durationMs: Date.now() - startedAt,
              audioChunkCount,
              audioHexChars,
              audioBytes: audioBuffer.length,
            });
            ws.close();
            resolve(audioBuffer);
          }
          return;
        }

        // 錯誤
        if (msg.base_resp?.status_code && msg.base_resp.status_code !== 0) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            log({ phase: "error", base_resp: msg.base_resp, durationMs: Date.now() - startedAt });
            reject(new Error(`合成失敗: ${msg.base_resp.status_msg} (code: ${msg.base_resp.status_code})`));
          }
        }
      } catch (err) {
        // 單條消息解析失敗不影響整體流程
        log({ phase: "response.parse_error", error: err instanceof Error ? err.message : String(err), rawPreview: raw.toString().slice(0, 500) });
      }
    });

    ws.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        log({ phase: "error", error: `WebSocket 連接失敗: ${err.message}`, durationMs: Date.now() - startedAt });
        reject(new Error(`WebSocket 連接失敗: ${err.message}`));
      }
    });

    ws.on("close", () => {
      log({ phase: "ws.close", resolved, durationMs: Date.now() - startedAt });
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // 連接關閉時如果已有音頻塊，返回；否則報錯
        if (audioChunks.length > 0) {
          const audioBuffer = Buffer.concat(audioChunks);
          log({ phase: "response.close_with_audio", audioChunkCount, audioHexChars, audioBytes: audioBuffer.length });
          resolve(audioBuffer);
        } else {
          log({ phase: "error", error: "連接已關閉，未收到音頻數據", durationMs: Date.now() - startedAt });
          reject(new Error("連接已關閉，未收到音頻數據"));
        }
      }
    });
  });
}
