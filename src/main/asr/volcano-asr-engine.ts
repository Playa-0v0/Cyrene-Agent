// 火山引擎流式 ASR 引擎 —— 大模型流式语音识别。
//
// 文档：https://www.volcengine.com/docs/6561/80818
// 协议：自定义二进制帧（header 4字节 + sequence 4字节 + payload_size 4字节 + gzip payload）
// 鉴权：WebSocket headers（旧版 X-Api-App-Key + X-Api-Access-Key；新版 X-Api-Key）
// URL：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async（双向流式优化版）

import { WebSocket } from "ws";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

const LOG_PREFIX = "[VolcanoASR]";

// 二进制协议常量
const PROTOCOL_V1 = 0x10;        // (1 << 4) | 0(header_size=1 → 4字节)
const MSG_FULL_REQ = 0x10;       // (1 << 4) | 0  full client request
const MSG_AUDIO_REQ = 0x20;      // (2 << 4) | 0  audio only request
const MSG_FULL_RESP = 0x90;      // (9 << 4) | 0  full server response
const MSG_ERROR = 0xF0;          // (15 << 4) | 0 error response
const FLAG_POS_SEQ = 0x01;       // 有 sequence 且为正
const FLAG_LAST = 0x02;          // 最后一包
const FLAG_NEG_SEQ = 0x03;       // 有 sequence 且为负（最后一包）
const SERIAL_JSON = 0x10;       // (1 << 4) | 0  JSON 序列化
const SERIAL_NONE = 0x00;       // 无序列化（音频数据）
const COMPRESS_GZIP = 0x01;      // gzip 压缩
const COMPRESS_NONE = 0x00;      // 不压缩

/** 火山 ASR 流式识别会话 */
export class VolcanoAsrStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private sequence = 1;
  private audioBuffer = Buffer.alloc(0);

  constructor(
    private readonly onPartial: (text: string) => void,
    private readonly onFinal: (text: string) => void,
  ) {}

  /**
   * 开始识别会话：连 WebSocket，鉴权，发配置帧。
   * appId = App ID（旧版控制台）或 App Key（新版控制台）
   * apiKey = Access Token（旧版）或留空（新版，鉴权用 X-Api-Key=appId）
   * isNewConsole = 是否新版控制台（新版用 X-Api-Key，旧版用 X-Api-App-Key + X-Api-Access-Key）
   */
  start(appId: string, apiKey: string, language: string): void {
    const reqId = randomUUID();
    const resourceId = "volc.seedasr.sauc.duration"; // 豆包 ASR 2.0 小时版
    const url = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
    console.log(LOG_PREFIX, `连接 ASR... appid=${appId}, lang=${language}`);

    // 鉴权 headers（同时兼容新旧版控制台）
    const headers: Record<string, string> = {
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": reqId,
      "X-Api-Connect-Id": reqId,
      "X-Api-Sequence": "-1",
    };
    if (apiKey) {
      // 旧版控制台：App ID + Access Token
      headers["X-Api-App-Key"] = appId;
      headers["X-Api-Access-Key"] = apiKey;
    } else {
      // 新版控制台：App Key
      headers["X-Api-Key"] = appId;
    }

    this.ws = new WebSocket(url, { headers });

    this.ws.on("open", () => {
      console.log(LOG_PREFIX, "WS 已连接，发送配置帧");
      this.sendConfig(language);
    });

    this.ws.on("message", (raw: Buffer) => this.handleMessage(raw));
    this.ws.on("error", (err) => console.error(LOG_PREFIX, "WS 错误:", err.message));
    this.ws.on("close", (code) => console.log(LOG_PREFIX, `WS 关闭: ${code}`));
  }

  /** 发送配置帧（full client request，二进制协议） */
  private sendConfig(language: string): void {
    const langMap: Record<string, string> = { zh: "zh-CN", en: "en-US", auto: "zh-CN" };
    const payload = {
      user: { uid: "cyrene" },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
        language: langMap[language] ?? "zh-CN",
      },
    };
    const frame = this.buildFrame(MSG_FULL_REQ, FLAG_POS_SEQ, SERIAL_JSON, COMPRESS_GZIP, payload, this.sequence);
    this.sequence++;
    try { this.ws?.send(frame); } catch (err) { console.error(LOG_PREFIX, "发送配置帧失败:", err); }
  }

  /** 发送一帧 PCM 音频（攒够 200ms/6400 字节再发） */
  sendAudio(pcmFrame: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.stopped) return;
    this.audioBuffer = Buffer.concat([this.audioBuffer, pcmFrame]);
    // 200ms = 16000 * 0.2 * 2 bytes = 6400 字节
    while (this.audioBuffer.length >= 6400) {
      const chunk = this.audioBuffer.subarray(0, 6400);
      this.audioBuffer = this.audioBuffer.subarray(6400);
      const frame = this.buildFrame(MSG_AUDIO_REQ, FLAG_POS_SEQ, SERIAL_NONE, COMPRESS_GZIP, chunk, this.sequence);
      this.sequence++;
      this.ws.send(frame, { binary: true });
    }
  }

  /** 结束识别，发最后一包（负包），关闭连接 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // 发剩余的音频
    if (this.audioBuffer.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const frame = this.buildFrame(MSG_AUDIO_REQ, FLAG_POS_SEQ, SERIAL_NONE, COMPRESS_GZIP, this.audioBuffer, this.sequence);
      this.sequence++;
      try { this.ws.send(frame, { binary: true }); } catch { /* ignore */ }
      this.audioBuffer = Buffer.alloc(0);
    }
    // 发负包（最后一包）
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const negFrame = this.buildFrame(MSG_AUDIO_REQ, FLAG_NEG_SEQ, SERIAL_NONE, COMPRESS_GZIP, Buffer.alloc(0), -this.sequence);
      try { this.ws.send(negFrame, { binary: true }); } catch { /* ignore */ }
    }
    setTimeout(() => { try { this.ws?.close(); } catch { /* ignore */ } }, 1000);
  }

  // ── 二进制协议编解码 ──

  /** 构建二进制帧 */
  private buildFrame(msgType: number, flags: number, serial: number, compress: number, payload: unknown, seq: number): Buffer {
    const payloadData = payload instanceof Buffer
      ? payload
      : Buffer.from(JSON.stringify(payload), "utf-8");
    const compressed = compress === COMPRESS_GZIP ? gzipSync(payloadData) : payloadData;

    const header = Buffer.alloc(4);
    header[0] = PROTOCOL_V1;              // version=1, header_size=1(4字节)
    header[1] = msgType | flags;          // message type + flags
    header[2] = serial | compress;        // serialization + compression
    header[3] = 0x00;                     // reserved

    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(seq, 0);

    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(compressed.length, 0);

    return Buffer.concat([header, seqBuf, sizeBuf, compressed]);
  }

  /** 解析服务端二进制响应 */
  private handleMessage(raw: Buffer): void {
    try {
      if (raw.length < 4) return;
      const headerSize = raw[0] & 0x0f;
      const messageType = raw[1] >> 4;
      const flags = raw[1] & 0x0f;
      const serialization = raw[2] >> 4;
      const compression = raw[2] & 0x0f;

      let offset = headerSize * 4; // header_size * 4 = 实际 header 字节数
      if (offset < 4 || offset > raw.length) offset = 4;

      let payload = raw.subarray(offset);
      let isLast = false;

      // 解析 flags
      if (flags & 0x01) {
        // 有 sequence 字段（4字节）
        if (flags & 0x02) isLast = true;
        payload = payload.subarray(4);
      }
      if (flags & 0x04) {
        // 有 event 字段（4字节）
        payload = payload.subarray(4);
      }

      // 错误响应
      if (messageType === 0x0F) {
        if (payload.length >= 8) {
          const code = payload.readInt32BE(0);
          const msgSize = payload.readUInt32BE(4);
          const errMsg = payload.subarray(8, 8 + msgSize).toString("utf-8");
          console.error(LOG_PREFIX, `ASR 错误: code=${code}, msg=${errMsg}`);
        }
        return;
      }

      // full server response：先读 payload_size
      if (payload.length >= 4) {
        const payloadSize = payload.readUInt32BE(0);
        payload = payload.subarray(4, 4 + payloadSize);
      }
      if (payload.length === 0) return;

      // gzip 解压
      if (compression === COMPRESS_GZIP) {
        try { payload = gunzipSync(payload); } catch (err) {
          console.error(LOG_PREFIX, "gzip 解压失败:", err);
          return;
        }
      }

      // JSON 解析
      if (serialization === 1) {
        const result = JSON.parse(payload.toString("utf-8")) as {
          result?: { text?: string; utterances?: Array<{ text?: string; definite?: boolean }> };
        };
        const text = result.result?.text
          ?? result.result?.utterances?.map(u => u.text ?? "").join("")
          ?? "";
        if (text) {
          if (isLast) {
            console.log(LOG_PREFIX, "最终识别:", text);
            this.onFinal(text);
          } else {
            this.onPartial(text);
          }
        }
      }
    } catch (err) {
      console.error(LOG_PREFIX, "解析响应失败:", err);
    }
  }
}

// ── 配置注入 ──

export interface AsrConfig {
  appId: string;
  apiKey: string;
  language: string;
  engine: string;
}

let asrConfigGetter: (() => AsrConfig | null) | null = null;

export function setAsrConfig(getter: () => AsrConfig | null): void {
  asrConfigGetter = getter;
}

export function getAsrConfig(): AsrConfig | null {
  return asrConfigGetter?.() ?? null;
}
