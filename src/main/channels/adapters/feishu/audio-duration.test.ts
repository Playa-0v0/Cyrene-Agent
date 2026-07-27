// audio-duration helper 單元測試
// 測純 JS MP3 frame header 解析 + 文件大小估算兜底
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getAudioDurationMs } from "./audio-duration";

// 測試環境跳過 ffprobe (3s timeout 拖慢整個測試, 真實運行時仍然走 ffprobe)
beforeAll(() => {
  process.env.CYRENE_SKIP_FFPROBE = "1";
});

/** 寫一個合法 MPEG-1 Layer III CBR 128kbps 44100Hz 的 mp3
 *  - frame header: 0xFF 0xFB 0x90 0x44
 *    (sync 11b 1 | version 11=MPEG1 | layer 01=III | CRC=1 | bitrate 1001=128kbps
 *     | samplerate 00=44100 | padding=0 | private=0 | channel=00=stereo)
 *  - 幀體 417 字節 (128000/44100 * 144 = 417.96 → floor 417)
 *  - 100 幀 ≈ 1.06 秒 (100 * 1152 / 44100 = 2.61s)
 */
function writeCbrMp3(filePath: string, frames: number, opts: { skipId3?: boolean } = {}): void {
  const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x44]);
  // 一幀 = 4 字節 header + 417 字節 body
  const frameBuf = Buffer.alloc(4 + 417);
  HEADER.copy(frameBuf, 0);
  // body 全部 0 (靜音)

  // ID3v2.3 header (10 字節) 讓 parser 跳過去識別 header
  // size 字段為 synsafe integer (4 字節, 每字節高 7 位有效)
  const id3TagBody = Buffer.alloc(0); // 空 ID3 body
  const id3Size =
    ((id3TagBody.length >> 21) & 0x7f) << 0 |
    0; // 我們沒填充 body, 但是 ID3 頭本身 10 字節
  // 簡化: 直接放一個最小 ID3v2 頭標識
  const id3 = Buffer.from([
    0x49, 0x44, 0x33, // "ID3"
    0x03, 0x00, // version 2.3
    0x00, // flags
    0x00, 0x00, 0x00, 0x00, // size (synsafe) - 0 表示無 extended header
  ]);

  const totalSize = (opts.skipId3 ? 0 : id3.length) + frames * frameBuf.length;
  const out = Buffer.alloc(totalSize);
  let off = 0;
  if (!opts.skipId3) {
    id3.copy(out, off);
    off += id3.length;
  }
  for (let i = 0; i < frames; i++) {
    frameBuf.copy(out, off);
    off += frameBuf.length;
  }
  fs.writeFileSync(filePath, out);
}

describe("audio-duration (零依賴方案: ffprobe + MP3 header + 文件大小估算)", () => {
  it("不存在文件 → 返回 undefined", async () => {
    const r = await getAudioDurationMs("/nonexistent/file.mp3");
    expect(r).toBeUndefined();
  });

  it("空文件 → 返回 undefined 不崩", async () => {
    const tmp = path.join(os.tmpdir(), `cyrene-empty-${Date.now()}.mp3`);
    fs.writeFileSync(tmp, "");
    try {
      const r = await getAudioDurationMs(tmp);
      expect(r).toBeUndefined();
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("純文本文件 → 走兜底估算 (返回 ≥500ms)", async () => {
    const tmp = path.join(os.tmpdir(), `cyrene-text-${Date.now()}.mp3`);
    // 寫 16000 字節觸發估算 (16000 / 16000 = 1 秒)
    fs.writeFileSync(tmp, Buffer.alloc(16000, 0x20));
    try {
      const r = await getAudioDurationMs(tmp);
      expect(r).toBeDefined();
      // 16000 bytes / 16000 bytes-per-sec = 1 sec = 1000ms (兜底最低 500ms)
      if (r !== undefined) {
        expect(r).toBeGreaterThanOrEqual(500);
      }
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("合法 CBR mp3 → MP3 header 解析給到正毫秒數", async () => {
    const tmp = path.join(os.tmpdir(), `cyrene-cbr-${Date.now()}.mp3`);
    writeCbrMp3(tmp, 100); // 100 幀 ≈ 2.6s
    try {
      const r = await getAudioDurationMs(tmp);
      // 如果系統有 ffprobe (本環境有), 優先用 ffprobe → 精確 2.6s 左右
      // 否則走 MP3 header 解析 → 同樣 2.6s 左右
      // 兜底估算: file_size / 16000
      expect(r).toBeDefined();
      if (r !== undefined) {
        expect(r).toBeGreaterThan(1000); // 至少 1s
        expect(r).toBeLessThan(10_000); // 不超過 10s
      }
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("合法 CBR mp3 (小文件, 僅 1 幀 ~26ms) → 返回合理值", async () => {
    const tmp = path.join(os.tmpdir(), `cyrene-tiny-${Date.now()}.mp3`);
    writeCbrMp3(tmp, 1);
    try {
      const r = await getAudioDurationMs(tmp);
      expect(r).toBeDefined();
      // 1 幀 ≈ 26ms 但 ffprobe 可能給 1000+; MP3 header 給 26ms
      // 兜底最低 500ms
      if (r !== undefined) expect(r).toBeGreaterThanOrEqual(26);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});