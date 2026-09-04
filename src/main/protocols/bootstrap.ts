import { app, net, protocol } from "electron";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { getUiFontResponseHeaders, isSafeUiFontRequest } from "../ui-font-protocol";
import { getStickersDir } from "../sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "../sticker-protocol";
import { parseMomentMediaUrl, resolveMomentMediaPath } from "../moments/moment-media-protocol";
import { getMomentsMediaRootDir } from "../moments/moments-store";

/**
 * 注册自定义协议的特权。
 *
 * 注意：必须在 app.ready 之前调用，否则 scheme 无法被渲染进程识别。
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "local-sticker", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: "local-font", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    { scheme: "moment-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function getUiFontsDir(): string {
  return path.join(app.getPath("userData"), "ui-fonts");
}

/**
 * 注册本地用户资源协议的实际处理器。
 *
 * - local-sticker:// 将请求映射到 userData/stickers/ 下的文件
 * - local-font:// 将请求映射到 userData/ui-fonts/ 下的文件
 * - moment-media:// 将请求映射到 userData/moments-media/<postId>/ 下的文件（白名单映射式解析）
 */
export function registerProtocolHandlers(): void {
  protocol.handle("local-sticker", (request) => {
    const file = parseLocalStickerFileFromUrl(request.url);
    if (!file) return new Response("Invalid sticker URL", { status: 404 });

    const filePath = resolveLocalStickerPath(getStickersDir(), file);
    if (!filePath) return new Response("Invalid sticker path", { status: 403 });

    return net.fetch(pathToFileURL(filePath).toString());
  });

  protocol.handle("moment-media", (request) => {
    const parsed = parseMomentMediaUrl(request.url);
    if (!parsed) return new Response("Invalid moment media URL", { status: 404 });

    const filePath = resolveMomentMediaPath(getMomentsMediaRootDir(), parsed.postId, parsed.file);
    if (!filePath || !fs.existsSync(filePath)) return new Response("Moment media not found", { status: 404 });

    return net.fetch(pathToFileURL(filePath).toString());
  });

  protocol.handle("local-font", (request) => {
    let fileName: string;
    try {
      fileName = decodeURIComponent(new URL(request.url).hostname);
    } catch {
      return new Response("Invalid font URL", { status: 404 });
    }
    if (!isSafeUiFontRequest(fileName)) return new Response("Invalid font URL", { status: 404 });
    const filePath = path.join(getUiFontsDir(), fileName);
    if (path.dirname(filePath) !== getUiFontsDir() || !fs.existsSync(filePath)) return new Response("Font not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString()).then((response) => new Response(response.body, {
      headers: getUiFontResponseHeaders(fileName),
    }));
  });
}
