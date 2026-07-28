import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildImageCaptionPrompt,
  validateCaptionImagePath,
  IMAGE_CAPTION_MAX_BYTES,
  IMAGE_CAPTION_PROMPT,
} from "./image-caption";

describe("validateCaptionImagePath", () => {
  it("只在用户做过标注时增强视觉提示", () => {
    expect(buildImageCaptionPrompt(false)).toBe(IMAGE_CAPTION_PROMPT);
    expect(buildImageCaptionPrompt(true)).toContain("用户主动添加");
  });

  it("拒绝非字符串 filePath", () => {
    expect(validateCaptionImagePath(123)).toEqual({ ok: false, error: "filePath 必须是 string" });
  });

  it("拒绝不存在的图片文件", () => {
    const missing = path.join(os.tmpdir(), "cyrene-missing-image.png");
    expect(validateCaptionImagePath(missing)).toEqual({ ok: false, error: "文件不存在" });
  });

  it("拒绝非图片扩展名", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-caption-"));
    try {
      const fp = path.join(tmpDir, "note.txt");
      fs.writeFileSync(fp, "hello");
      expect(validateCaptionImagePath(fp)).toEqual({ ok: false, error: "只支持图片文件" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("拒绝超过大小限制的图片", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-caption-"));
    try {
      const fp = path.join(tmpDir, "large.png");
      fs.writeFileSync(fp, Buffer.alloc(IMAGE_CAPTION_MAX_BYTES + 1));
      expect(validateCaptionImagePath(fp)).toEqual({ ok: false, error: "图片不能超过 20MB" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("返回合法图片的 mime 和 buffer", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-caption-"));
    try {
      const fp = path.join(tmpDir, "ok.png");
      fs.writeFileSync(fp, Buffer.from([1, 2, 3]));
      const result = validateCaptionImagePath(fp);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mime).toBe("image/png");
        expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
