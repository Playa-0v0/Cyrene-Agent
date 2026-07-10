import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\tmp\\cyrene-test",
    getName: () => "live2d-cyrene-test",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

import { normalizeOneBotPayload } from "./index";

describe("QqNapCatAdapter normalizeOneBotPayload", () => {
  it("keeps plain text messages", () => {
    expect(normalizeOneBotPayload("hello", undefined)).toEqual({ text: "hello" });
  });

  it("normalizes array text and at segments", () => {
    const normalized = normalizeOneBotPayload(
      [
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " 你好" } },
      ],
      undefined,
    );
    expect(normalized.text).toBe("[CQ:at,qq=12345] 你好");
    expect(normalized.attachments).toBeUndefined();
  });

  it("extracts image attachments", () => {
    const normalized = normalizeOneBotPayload(
      [
        { type: "text", data: { text: "看图" } },
        { type: "image", data: { file: "abc.jpg", url: "http://127.0.0.1/image/abc.jpg" } },
      ],
      undefined,
    );
    expect(normalized.text).toContain("看图");
    expect(normalized.text).toContain("[图片:http://127.0.0.1/image/abc.jpg]");
    expect(normalized.attachments).toEqual([
      { kind: "image", url: "http://127.0.0.1/image/abc.jpg", caption: "abc.jpg" },
    ]);
  });

  it("extracts file, audio, and video attachments", () => {
    const normalized = normalizeOneBotPayload(
      [
        { type: "file", data: { file: "report.pdf", url: "http://127.0.0.1/file/report.pdf" } },
        { type: "record", data: { file: "voice.amr", url: "http://127.0.0.1/file/voice.amr" } },
        { type: "video", data: { file: "clip.mp4", url: "http://127.0.0.1/file/clip.mp4" } },
      ],
      undefined,
    );
    expect(normalized.attachments).toEqual([
      { kind: "file", url: "http://127.0.0.1/file/report.pdf", caption: "report.pdf" },
      { kind: "audio", url: "http://127.0.0.1/file/voice.amr", caption: "voice.amr" },
      { kind: "video", url: "http://127.0.0.1/file/clip.mp4", caption: "clip.mp4" },
    ]);
  });
});
