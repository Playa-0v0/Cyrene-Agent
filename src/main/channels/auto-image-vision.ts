import * as fs from "fs";
import * as path from "path";
import type { ChannelAttachment } from "./types";
import { captionImage, type VisionConfig, type VisionImage } from "../orchestrator/vision-captioner";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type CaptionFn = (image: VisionImage, query: string, config: VisionConfig) => Promise<string>;

export interface AutomaticImageVisionDeps {
  fetchImpl?: typeof fetch;
  caption?: CaptionFn;
}

function inferMime(value: string): string | null {
  const pathname = (() => {
    try { return new URL(value).pathname; } catch { return value; }
  })();
  switch (path.extname(pathname).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return null;
  }
}

async function readAttachmentImage(
  attachment: ChannelAttachment,
  fetchImpl: typeof fetch,
): Promise<VisionImage> {
  if (attachment.filePath) {
    const stat = fs.statSync(attachment.filePath);
    if (!stat.isFile()) throw new Error("附件不是檔案");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error("圖片超過 10 MB");
    const mime = attachment.mime?.toLowerCase() || inferMime(attachment.filePath);
    if (!mime || !SUPPORTED_MIMES.has(mime)) throw new Error("不支援的圖片格式");
    return { base64: fs.readFileSync(attachment.filePath).toString("base64"), mime };
  }

  if (!attachment.url) throw new Error("圖片附件沒有可讀取的位置");
  const response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`下載圖片失敗：HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error("圖片超過 10 MB");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("圖片超過 10 MB");
  const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  const mime = attachment.mime?.toLowerCase() || responseMime || inferMime(attachment.url);
  if (!mime || !SUPPORTED_MIMES.has(mime)) throw new Error("不支援的圖片格式");
  return { base64: bytes.toString("base64"), mime };
}

/**
 * 自動下載並辨識入站圖片，產生只供本輪 agent 使用的可信 system context。
 * 圖片本體與 base64 不寫入聊天歷史。
 */
export async function buildAutomaticImageContext(
  attachments: ChannelAttachment[] | undefined,
  userQuery: string,
  config: VisionConfig | null,
  deps: AutomaticImageVisionDeps = {},
): Promise<string> {
  const images = (attachments ?? []).filter((attachment) => attachment.kind === "image").slice(0, MAX_IMAGES);
  if (!images.length || !config) return "";

  const fetchImpl = deps.fetchImpl ?? fetch;
  const caption = deps.caption ?? captionImage;
  const descriptions = await Promise.all(images.map(async (attachment, index) => {
    try {
      const image = await readAttachmentImage(attachment, fetchImpl);
      const result = await caption(image, userQuery, config);
      if (!result || result.startsWith("[錯誤")) throw new Error(result || "視覺模型沒有回覆");
      return `圖片 ${index + 1}：${result.trim()}`;
    } catch (error) {
      console.warn("[ChannelsVision] 圖片自動辨識失敗:", error instanceof Error ? error.message : error);
      return "";
    }
  }));

  const successful = descriptions.filter(Boolean);
  if (!successful.length) return "";
  return [
    "【系統已自動辨識本輪圖片附件】",
    ...successful,
    "請直接根據以上圖片內容回答使用者，不要反問圖片主題，也不要聲稱自己看不到圖片。",
  ].join("\n");
}
