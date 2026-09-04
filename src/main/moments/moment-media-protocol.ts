// moment-media:// 协议的安全解析（照 sticker-protocol.ts 模式）。
//
// 安全边界（写死）：
// - 映射式解析：postId + 文件名 → 主进程拼绝对路径，禁止 path.join(root, decodedUrl) 直拼；
// - postId 白名单正则（moments-store 生成的 id 形如 moment_<ts>_<rand>）；
// - 文件名白名单正则（<序号>.<白名单扩展名>）；
// - 解析结果必须位于 mediaRootDir 内（杜绝 ../ 路径穿越）。

import * as path from "path";

const SAFE_POST_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp)$/i;

export function parseMomentMediaUrl(rawUrl: string): { postId: string; file: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "moment-media:") return null;

  let postId: string;
  let file: string;
  try {
    postId = decodeURIComponent(url.host || "");
    file = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }

  if (!SAFE_POST_ID.test(postId) || !SAFE_FILE_NAME.test(file)) return null;
  return { postId, file };
}

export function resolveMomentMediaPath(
  mediaRootDir: string,
  postId: string,
  file: string,
): string | null {
  if (!SAFE_POST_ID.test(postId) || !SAFE_FILE_NAME.test(file)) return null;

  const base = path.resolve(mediaRootDir);
  const resolved = path.resolve(base, postId, file);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}
