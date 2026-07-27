// screenshot —— desktopCapturer 截主屏 → PNG base64 + 實際尺寸。
// Electron 內置，免裝庫。返回的 width/height 用於 VLM 座標歸一化轉像素。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { desktopCapturer, nativeImage, screen } from "electron";
import type { ImgData } from "./vlm-locator";

export interface ScreenshotResult extends ImgData {
  width: number;
  height: number;
}

const CAPTURE_TIMEOUT_MS = 8_000;

async function captureWithDesktopCapturer(width: number, height: number): Promise<Electron.NativeImage | null> {
  const work = desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
  });
  const sources = await Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("desktopCapturer timeout")), CAPTURE_TIMEOUT_MS)),
  ]);
  return sources[0]?.thumbnail ?? null;
}

async function captureWithMacosTool(): Promise<Electron.NativeImage | null> {
  const file = path.join(os.tmpdir(), `cyrene-game-screen-${process.pid}-${Date.now()}.png`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/sbin/screencapture", ["-x", "-m", file], { timeout: 15_000 }, (error) => {
        if (error) reject(error); else resolve();
      });
    });
    const image = nativeImage.createFromPath(file);
    return image.isEmpty() ? null : image;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** 截取主屏幕，返回 PNG base64 + 實際像素尺寸。失敗返回 null。 */
export async function captureScreen(): Promise<ScreenshotResult | null> {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  let thumb: Electron.NativeImage | null = null;
  try {
    thumb = await captureWithDesktopCapturer(width, height);
  } catch (error) {
    console.warn("[GameBot] Electron 全螢幕擷取失敗，改用 macOS screencapture:", error);
  }
  if (!thumb && process.platform === "darwin") {
    try { thumb = await captureWithMacosTool(); }
    catch (error) { console.error("[GameBot] macOS 截圖備援失敗:", error); }
  }
  if (!thumb) return null;
  const size = thumb.getSize();
  const png = thumb.toPNG();
  return {
    base64: png.toString("base64"),
    mime: "image/png",
    width: size.width,
    height: size.height,
  };
}
