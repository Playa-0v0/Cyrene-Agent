import * as fs from "fs";
import * as path from "path";
import { getMimeFromExt, isImageExt } from "../rag/file-ingest";
import { userAnnotationNotice } from "../../shared/chat-context";

export const IMAGE_CAPTION_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_CAPTION_PROMPT = "请简洁描述这张图片的主要内容，重点提取用户可能想让你看的信息。";

export function buildImageCaptionPrompt(hasAnnotations: boolean): string {
  const notice = userAnnotationNotice(hasAnnotations);
  return notice ? `${IMAGE_CAPTION_PROMPT}\n\n${notice}` : IMAGE_CAPTION_PROMPT;
}

export type ValidCaptionImage =
  | { ok: true; filePath: string; buffer: Buffer; mime: string }
  | { ok: false; error: string };

export function validateCaptionImagePath(filePath: unknown): ValidCaptionImage {
  if (typeof filePath !== "string") {
    return { ok: false, error: "filePath 必须是 string" };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: "文件不存在" };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { ok: false, error: "不是文件" };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!isImageExt(ext)) {
    return { ok: false, error: "只支持图片文件" };
  }
  if (stat.size > IMAGE_CAPTION_MAX_BYTES) {
    return { ok: false, error: "图片不能超过 20MB" };
  }

  return {
    ok: true,
    filePath,
    buffer: fs.readFileSync(filePath),
    mime: getMimeFromExt(ext),
  };
}
