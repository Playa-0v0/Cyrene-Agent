// 估算本地 MP3 文件的时长（毫秒），用于飞书 SDK 的 LarkChannel.send({ audio: { duration } })。
//
// 飞书 SDK 的 MediaUploader.resolveDuration 只对 Opus 自动解析，
// 对 MP3 直接抛 "duration could not be determined for audio; pass it explicitly"。
//
// 我们采用三段 fallback（按可靠性 + 复杂度排序）：
//   1. ffprobe — 精确（系统装 ffmpeg 就有，零依赖）
//   2. MP3 frame header 解析 — 精确（CBR mp3 准）
//   3. 文件大小 / 假定 128kbps — 估算（保底，不会让 SDK fail）
//
// 都不引入 native 模块（避免 music-metadata v11 ESM 问题）。
import * as fs from "fs";
import { spawn } from "child_process";

const LOG = "[FeishuAudioDuration]";

/** 兜底估算：按 128 kbps CBR 推算。返回整数毫秒。 */
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

/** 用 ffprobe 拿时长。ffprobe -show_entries format=duration -of json file */
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

/** 用 Node 内置 Buffer 解析 MP3 frame header → 算出 bitrate + duration。
 *  对 CBR mp3 精确, 对 VBR 不准 (但仍能给出近似值)。 */
function parseMp3Duration(filePath: string): number | undefined {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 4) return undefined;

    // 跳 ID3v2 头: 'ID3' + 10 bytes header, size 在第 6-9 字节 (synsafe integer)
    let offset = 0;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const size =
        ((buf[6] & 0x7f) << 21) |
        ((buf[7] & 0x7f) << 14) |
        ((buf[8] & 0x7f) << 7) |
        (buf[9] & 0x7f);
      offset = 10 + size;
    }

    // 找第一个 11-bit 全 1 的 frame header
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
    const durationSec = totalFrames * 1152 / sampleRate; // Layer III 每帧 1152 samples
    return Math.round(durationSec * 1000);
  } catch {
    return undefined;
  }
}

/** 读本地音频文件时长（毫秒）。失败返回 undefined（调用方决定 fallback）。
 *
 *  三段 fallback:
 *    1) ffprobe (如果系统装了)
 *    2) MP3 frame header 解析
 *    3) 文件大小 / 128kbps 估算 (兜底, 让 SDK 不至于 duration=0 报错)
 */
export async function getAudioDurationMs(filePath: string): Promise<number | undefined> {
  // 仅 mp3 / m4a / ogg 走这个 helper. 其它格式飞书 SDK sendVideo/sendFile 不需要这个分支
  if (!filePath || !fs.existsSync(filePath)) return undefined;

  // 1) ffprobe (优先 - 精确)
  // 测试环境用 CYRENE_SKIP_FFPROBE=1 跳过加速; 真实环境仍然走 ffprobe
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

  // 2) 自己解析 mp3 frame header (纯 Buffer, 零依赖)
  const fromHeader = parseMp3Duration(filePath);
  if (fromHeader) {
    console.log(LOG, `mp3 header 解析: ${fromHeader}ms`);
    return fromHeader;
  }
  console.log(LOG, `mp3 header 解析失败（可能不是 mp3）: ${filePath}`);

  // 3) 兜底估算
  const est = estimateByFileSize(filePath);
  if (est) {
    console.warn(LOG, `估算时长: ${est}ms (建议安装 ffprobe 提高精度)`);
    return est;
  }

  console.warn(LOG, `无法计算时长: ${filePath}`);
  return undefined;
}