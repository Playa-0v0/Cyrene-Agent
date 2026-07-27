// 阿里雲實時語音識別 ASR 引擎 —— WebSocket + JSON 協議。
//
// 文檔：https://help.aliyun.com/zh/isi/developer-reference/websocket
// URL：wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1?token=<token>
// 鑑權：用 AccessKeyId + AccessKeySecret 獲取臨時 token，拼到 URL 裡
// 協議：JSON 文本幀（StartTranscription/StopTranscription）+ 二進制幀（PCM 音頻）
// 音頻：PCM 16kHz/16bit/mono

import { WebSocket } from "ws";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";

const LOG_PREFIX = "[AliyunASR]";
const NLS_GATEWAY = "wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1";

/** 阿里雲 ASR 流式識別會話 */
export class VolcanoAsrStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private audioBuffer = Buffer.alloc(0);
  private taskId = randomUUID().replace(/-/g, "");
  private appKey = "";
  private completed = false;
  private completionResolve: (() => void) | null = null;
  private completionPromise: Promise<void> | null = null;
  private ready = false;
  private readyResolve: ((ready: boolean) => void) | null = null;
  private readyPromise: Promise<boolean> | null = null;

  constructor(
    private readonly onPartial: (text: string) => void,
    private readonly onFinal: (text: string) => void,
  ) {}

  /** 開始識別會話：獲取 token → 連 WebSocket → 發 StartTranscription */
  async start(appKey: string, accessKeyId: string, accessKeySecret: string, language: string): Promise<void> {
    this.appKey = appKey;
    console.log(LOG_PREFIX, `獲取 token... appKey=${appKey}`);
    let token: string;
    try {
      token = await this.getToken(accessKeyId, accessKeySecret);
    } catch (err) {
      console.error(LOG_PREFIX, "獲取 token 失敗:", err);
      return;
    }
    console.log(LOG_PREFIX, "token 獲取成功，連接 WebSocket...");

    const url = `${NLS_GATEWAY}?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      if (this.stopped) {
        this.markCompleted();
        this.ws?.close();
        return;
      }
      console.log(LOG_PREFIX, "WS 已連接，發送 StartTranscription");
      this.sendStartTranscription(appKey, language);
    });

    this.ws.on("message", (raw: Buffer) => this.handleMessage(raw));
    this.ws.on("error", (err) => console.error(LOG_PREFIX, "WS 錯誤:", err.message));
    this.ws.on("close", (code) => {
      console.log(LOG_PREFIX, `WS 關閉: ${code}`);
      this.readyResolve?.(false);
      this.readyResolve = null;
      this.markCompleted();
    });
  }

  /** 等待服務端確認 TranscriptionStarted；批次音頻來源可用此方法避免開連線前丟幀。 */
  async waitUntilReady(timeoutMs = 5000): Promise<boolean> {
    if (this.ready) return true;
    if (!this.readyPromise) {
      this.readyPromise = new Promise<boolean>((resolve) => {
        this.readyResolve = resolve;
      });
    }
    return await Promise.race([
      this.readyPromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  /** 發送 StartTranscription 指令（JSON 文本幀） */
  private sendStartTranscription(appKey: string, language: string): void {
    const langMap: Record<string, string> = { zh: "zh-CN", en: "en-US" };
    const msg = {
      header: {
        message_id: randomUUID().replace(/-/g, ""),
        task_id: this.taskId,
        namespace: "SpeechTranscriber",
        name: "StartTranscription",
        appkey: appKey,
      },
      payload: {
        format: "pcm",
        sample_rate: 16000,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
        max_sentence_silence: 800,
      },
    };
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      console.error(LOG_PREFIX, "發送 StartTranscription 失敗:", err);
    }
  }

  /** 發送一幀 PCM 音頻（攢夠 200ms/6400 字節再發） */
  sendAudio(pcmFrame: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.stopped) return;
    this.audioBuffer = Buffer.concat([this.audioBuffer, pcmFrame]);
    // 200ms = 16000 * 0.2 * 2 = 6400 字節
    while (this.audioBuffer.length >= 6400) {
      const chunk = this.audioBuffer.subarray(0, 6400);
      this.audioBuffer = this.audioBuffer.subarray(6400);
      this.ws.send(chunk, { binary: true });
    }
  }

  /** 結束識別：發剩餘音頻 + StopTranscription */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // 發剩餘音頻
    if (this.audioBuffer.length > 0) {
      try { this.ws.send(this.audioBuffer, { binary: true }); } catch { /* ignore */ }
      this.audioBuffer = Buffer.alloc(0);
    }

    // 發 StopTranscription 指令
    const msg = {
      header: {
        message_id: randomUUID().replace(/-/g, ""),
        task_id: this.taskId,
        namespace: "SpeechTranscriber",
        name: "StopTranscription",
        appkey: this.appKey,
      },
    };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }

    setTimeout(() => { try { this.ws?.close(); } catch { /* ignore */ } }, 2000);
  }

  /**
   * 結束識別並等待服務端回傳最終 SentenceEnd/TranscriptionCompleted。
   * 網路異常時最多等 timeoutMs，避免通話狀態卡住。
   */
  async stopAndWaitFinal(timeoutMs = 1800): Promise<void> {
    if (this.completed) return;
    if (!this.completionPromise) {
      this.completionPromise = new Promise<void>((resolve) => {
        this.completionResolve = resolve;
      });
    }
    this.stop();
    await Promise.race([
      this.completionPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private markCompleted(): void {
    if (this.completed) return;
    this.completed = true;
    this.completionResolve?.();
    this.completionResolve = null;
  }

  /** 解析服務端 JSON 響應 */
  private handleMessage(raw: Buffer): void {
    try {
      const msg = JSON.parse(raw.toString()) as {
        header?: {
          status?: number;
          status_text?: string;
          task_id?: string;
          name?: string;
        };
        payload?: {
          result?: string;
          index?: number;
          time?: number;
          confidence?: number;
        };
      };

      const status = msg.header?.status;
      const eventName = msg.header?.name;

      if (status !== 20000000 && status !== undefined) {
        console.error(LOG_PREFIX, `ASR 錯誤: status=${status}, msg=${msg.header?.status_text}`);
        return;
      }

      if (eventName === "TranscriptionStarted") {
        console.log(LOG_PREFIX, "轉寫已開始，可以發送音頻");
        this.ready = true;
        this.readyResolve?.(true);
        this.readyResolve = null;
      } else if (eventName === "TranscriptionResultChanged") {
        // 中間結果
        const text = msg.payload?.result ?? "";
        if (text) this.onPartial(text);
      } else if (eventName === "SentenceEnd") {
        // 最終結果
        const text = msg.payload?.result ?? "";
        if (text) {
          console.log(LOG_PREFIX, "最終識別:", text);
          this.onFinal(text);
        }
      } else if (eventName === "TranscriptionCompleted") {
        console.log(LOG_PREFIX, "轉寫已完成");
        this.markCompleted();
      }
    } catch (err) {
      console.error(LOG_PREFIX, "解析響應失敗:", err);
    }
  }

  /** 用 AccessKeyId + AccessKeySecret 獲取阿里雲臨時 token */
  private async getToken(accessKeyId: string, accessKeySecret: string): Promise<string> {
    // 阿里雲 NLS token 獲取：RPC 風格 API 簽名
    const params: Record<string, string> = {
      AccessKeyId: accessKeyId,
      Action: "CreateToken",
      Format: "JSON",
      RegionId: "cn-shanghai",
      SignatureMethod: "HMAC-SHA256",
      SignatureNonce: randomUUID().replace(/-/g, ""),
      SignatureVersion: "1.0",
      Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      Version: "2019-02-28",
    };

    // 按字母序排列參數
    const sortedKeys = Object.keys(params).sort();
    const canonicalQuery = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");

    // 構建簽名字符串
    const stringToSign = `GET&%2F&${encodeURIComponent(canonicalQuery)}`;

    // HMAC-SHA256 簽名（阿里雲簽名附加 &）
    const signature = createHmac("sha256", accessKeySecret + "&")
      .update(stringToSign)
      .digest("base64");

    // 構建完整 URL
    const url = `https://nls-meta.cn-shanghai.aliyuncs.com/?${canonicalQuery}&Signature=${encodeURIComponent(signature)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { Token?: { Id?: string }; errmsg?: string };
    if (!data.Token?.Id) throw new Error(data.errmsg || "token 獲取失敗");
    return data.Token.Id;
  }
}

// ── 配置注入 ──

export interface AsrConfig {
  appKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  language: string;
  engine: string;
  fallbackToLocal?: boolean;
}

let asrConfigGetter: (() => AsrConfig | null) | null = null;

export function setAsrConfig(getter: () => AsrConfig | null): void {
  asrConfigGetter = getter;
}

export function getAsrConfig(): AsrConfig | null {
  return asrConfigGetter?.() ?? null;
}
