import * as path from "path";

export function buildLocalStickerUrl(file: string): string {
  return `local-sticker:///${encodeURIComponent(file)}`;
}

export function parseLocalStickerFileFromUrl(rawUrl: string): string | null {
  if (/(?:^|[\\/])(?:\.\.|%2e%2e)(?:[\\/]|$)/i.test(rawUrl)) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const rawFile = url.pathname.replace(/^\/+/, "") || url.host;
  if (!rawFile) return null;

  let file: string;
  try {
    file = decodeURIComponent(rawFile);
  } catch {
    return null;
  }

  if (!file || file === "." || file === "..") return null;
  if (file.includes("/") || file.includes("\\")) return null;
  return file;
}

export function resolveLocalStickerPath(stickersDir: string, file: string): string | null {
  if (!file || file.includes("/") || file.includes("\\")) return null;

  const base = path.resolve(stickersDir);
  const resolved = path.resolve(base, file);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}
