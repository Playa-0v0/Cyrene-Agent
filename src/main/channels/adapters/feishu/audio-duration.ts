// 估算本地 MP3 文件的時長（毫秒），用於飛書 SDK 的 LarkChannel.send({ audio: { duration } })。
//
// 飛書 SDK 的 MediaUploader.resolveDuration 只對 Opus 自動解析，
// 對 MP3 直接拋 "duration could not be determined for audio; pass it explicitly"。
//
// 我們採用三段 fallback（按可靠性 + 複雜度排序）：
//   1. ffprobe — 精確（系統裝 ffmpeg 就有，零依賴）
//   2. MP3 frame header 解析 — 精確（CBR mp3 準）
//   3. 文件大小 / 假定 128kbps — 估算（保底，不會讓 SDK fail）
//
// 都不引入 native 模塊（避免 music-metadata v11 ESM 問題）。
import * as fs from "fs";
import { spawn } from "child_process";

const LOG = "[FeishuAudioDuration]";

/** 兜底估算：按 128 kbps CBR 推算。返回整數毫秒。 */
function estimateByFileSize(filePath: string): number | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 1024) return undefined;
    // 128 kbps = 16000 bytes/sec
    const secs = stat.size / 16000;
    return Math.max(500, Math.round(secs * 1000));
  } catch {
    return undefined;
  }
}

/** 用 ffprobe 拿時長。ffprobe -show_entries format=duration -of json file */
function probeWithFfprobe(filePath: string, ffprobePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        ffprobePath,
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "json",
          filePath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        proc.kill();
        resolve(undefined);
      }, 3000);
      proc.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      proc.stderr.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      proc.on("close", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(out);
          const d = json?.format?.duration;
          if (typeof d === "number" && Number.isFinite(d) && d > 0) {
            resolve(Math.round(d * 1000));
          } else if (typeof d === "string") {
            const n = Number(d);
            if (Number.isFinite(n) && n > 0) resolve(Math.round(n * 1000));
            else resolve(undefined);
          } else {
            resolve(undefined);
          }
        } catch {
          resolve(undefined);
        }
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** 用 Node 內置 Buffer 解析 MP3 frame header → 算出 bitrate + duration。
 *  對 CBR mp3 精確, 對 VBR 不準 (但仍能給出近似值)。 */
function parseMp3Duration(filePath: string): number | undefined {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 4) return undefined;

    // 跳 ID3v2 頭: 'ID3' + 10 bytes header, size 在第 6-9 字節 (synsafe integer)
    let offset = 0;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const size =
        ((buf[6] & 0x7f) << 21) |
        ((buf[7] & 0x7f) << 14) |
        ((buf[8] & 0x7f) << 7) |
        (buf[9] & 0x7f);
      offset = 10 + size;
    }

    // 找第一個 11-bit 全 1 的 frame header
    while (offset + 4 <= buf.length) {
      if (
        buf[offset] === 0xff &&
        (buf[offset + 1] & 0xe0) === 0xe0
      ) {
        break;
      }
      offset++;
    }

    if (offset + 4 > buf.length) return undefined;
    const header = buf.readUInt32BE(offset);

    // MPEG-1 Layer III bitrate 查表 (kbps)
    const BITRATE_M1_L3 = [
      0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ];
    // MPEG-2 Layer III bitrate 查表
    const BITRATE_M2_L3 = [
      0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ];
    // sample rate 查表 (Hz)
    const SAMPLERATE = [44100, 48000, 32000, 0];

    const versionId = (header >> 19) & 0x3; // 11=MPEG1, 10=MPEG2
    const layerId = (header >> 17) & 0x3;    // 01=LayerIII
    const bitrateIdx = (header >> 12) & 0xf;
    const srIdx = (header >> 10) & 0x3;
    const padding = (header >> 9) & 0x1;

    if (versionId !== 3 || layerId !== 1) return undefined; // 不支持的格式
    if (bitrateIdx === 0 || bitrateIdx === 15) return undefined;
    if (srIdx === 3) return undefined;

    const bitrateKbps = BITRATE_M1_L3[bitrateIdx] ?? 0;
    const sampleRate = SAMPLERATE[srIdx] ?? 0;
    if (bitrateKbps <= 0 || sampleRate <= 0) return undefined;

    // Layer III frame size: 144 * bitrate / sampleRate + padding
    const frameSize = Math.floor((144 * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0);
    if (frameSize <= 0) return undefined;

    const audioBytes = buf.length - offset;
    const totalFrames = audioBytes / frameSize;
    const durationSec = totalFrames * 1152 / sampleRate; // Layer III 每幀 1152 samples
    return Math.round(durationSec * 1000);
  } catch {
    return undefined;
  }
}

/** 讀本地音頻文件時長（毫秒）。失敗返回 undefined（調用方決定 fallback）。
 *
 *  三段 fallback:
 *    1) ffprobe (如果系統裝了)
 *    2) MP3 frame header 解析
 *    3) 文件大小 / 128kbps 估算 (兜底, 讓 SDK 不至於 duration=0 報錯)
 */
export async function getAudioDurationMs(filePath: string): Promise<number | undefined> {
  // 僅 mp3 / m4a / ogg 走這個 helper. 其它格式飛書 SDK sendVideo/sendFile 不需要這個分支
  if (!filePath || !fs.existsSync(filePath)) return undefined;

  // 1) ffprobe (優先 - 精確)
  // 測試環境用 CYRENE_SKIP_FFPROBE=1 跳過加速; 真實環境仍然走 ffprobe
  if (!process.env.CYRENE_SKIP_FFPROBE) {
    const candidates = [
      "ffprobe",
      "C:\\Users\\Public\\ffmpeg\\bin\\ffprobe.exe",
      "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe",
    ];
    for (const c of candidates) {
      try {
        const r = await probeWithFfprobe(filePath, c);
        if (r) return r;
      } catch {
        /* try next */
      }
    }
  }

  // 2) 自己解析 mp3 frame header (純 Buffer, 零依賴)
  const fromHeader = parseMp3Duration(filePath);
  if (fromHeader) {
    console.log(LOG, `mp3 header 解析: ${fromHeader}ms`);
    return fromHeader;
  }

  // 3) 兜底估算
  const est = estimateByFileSize(filePath);
  if (est) {
    console.warn(LOG, `估算時長: ${est}ms (建議安裝 ffprobe 提高精度)`);
    return est;
  }

  console.warn(LOG, `無法計算時長: ${filePath}`);
  return undefined;
}