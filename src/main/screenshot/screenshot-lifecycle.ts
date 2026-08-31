import * as path from "node:path";
import * as fs from "fs";
import { spawn } from "node:child_process";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage } from "electron";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import { ElectronScreenshotHelperClient } from "./helper-client";
import { resolveScreenshotHelperPath } from "./helper-path";
import {
  createScreenshotService,
  validateScreenshotInsert,
  type ScreenshotInsertData,
  type ScreenshotService,
} from "./screenshot-service";

export type { ScreenshotService };

export interface ScreenshotLifecycleOptions {
  initialHotkey: string;
  getReactChatWindow: () => BrowserWindow | null;
  captureMainWindow: () => Promise<Electron.NativeImage | null>;
}

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

function getScreenshotDirectory(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

/**
 * 确保 helper 的输出目录存在。
 * WIC InitializeFromFilename 不会创建父目录：目录缺失时打开 `<uuid>.png.tmp`
 * 直接报 0x80070003（ERROR_PATH_NOT_FOUND）。mkdir recursive 幂等，重复调用无害。
 */
async function ensureScreenshotDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (error) {
    console.error("[Screenshot] 创建截图目录失败:", directory, error);
  }
}

async function saveScreenshotPasteTemp(
  base64: string,
  _mime: string,
): Promise<{ filePath: string }> {
  const raw = Buffer.from(base64, "base64");
  if (raw.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error("SCREENSHOT_TOO_LARGE");
  }
  const image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) {
    throw new Error("INVALID_SCREENSHOT_IMAGE");
  }
  const screenshotDirectory = getScreenshotDirectory();
  await fs.promises.mkdir(screenshotDirectory, { recursive: true });
  const filePath = path.join(screenshotDirectory, `${randomUUID()}.png`);
  await fs.promises.writeFile(filePath, image.toPNG());
  return { filePath };
}

export function initializeScreenshotService(
  options: ScreenshotLifecycleOptions,
): ScreenshotService {
  const { getReactChatWindow, captureMainWindow } = options;
  const screenshotDirectory = getScreenshotDirectory();

  const validateInsert = (data: ScreenshotInsertData): ScreenshotInsertData => {
    let previewImage: Electron.NativeImage | null = null;
    const validated = validateScreenshotInsert(
      data,
      screenshotDirectory,
      (filePath) => {
        previewImage = nativeImage.createFromPath(filePath);
        return previewImage;
      },
    );
    if (!validated) {
      throw new Error(`INVALID_SCREENSHOT_RESULT:${data.filePath}`);
    }
    // React 开发预览运行在 http://，Chromium 会拦截 file:// 图片。
    // 截图体积有限，直接回传 data URL，旧 Chat 与 React 都能稳定显示。
    return {
      ...validated,
      previewUrl: previewImage ? (previewImage as Electron.NativeImage).toDataURL() : validated.previewUrl,
    };
  };

  const client = new ElectronScreenshotHelperClient({
    spawnImpl: (command, args) =>
      spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    resolveHelperPath: () =>
      resolveScreenshotHelperPath({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        envOverride: process.env.CYRENE_SCREENSHOT_HELPER_PATH,
      }),
    screenshotDirectory,
    logger: console,
  });
  // 启动即建目录 + 记录实际输出目录（排查 0x80070003 类路径问题）。
  void ensureScreenshotDirectory(screenshotDirectory);
  console.log("[Screenshot] helper output-dir =", screenshotDirectory);

  const service = createScreenshotService({
    client,
    registerShortcut: (accelerator, callback) =>
      globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    sendInsert: (data) => {
      const validated = validateInsert(data);
      const reactChatWindow = getReactChatWindow();
      if (reactChatWindow && !reactChatWindow.isDestroyed()) {
        reactChatWindow.webContents.send(IPC.SCREENSHOT_INSERT, validated);
      }
    },
  });

  ipcMain.handle(IPC.SCREENSHOT_START, async (event) => {
    // 请求前兜底重建目录：清理软件可能删掉 AppData 下的子目录，
    // helper 的 WIC 编码不会自建父目录（0x80070003）。
    await ensureScreenshotDirectory(screenshotDirectory);
    return service.startFromChatButton((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.SCREENSHOT_INSERT, validateInsert(data));
      }
    });
  });
  ipcMain.handle(IPC.SCREENSHOT_SAVE_TEMP, (_event, base64: string, mime: string) =>
    saveScreenshotPasteTemp(base64, mime),
  );
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, () => {
    service.suspendHotkey();
    return true;
  });
  ipcMain.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, () => {
    service.resumeHotkey();
    return true;
  });

  ipcMain.handle("debug:screenshot", async () => {
    const image = await captureMainWindow();
    if (!image) return null;
    const png = image.toPNG();
    const outPath = path.join(app.getPath("temp"), "cyrene-screenshot.png");
    fs.writeFileSync(outPath, png);
    return outPath;
  });

  service.init(options.initialHotkey);
  return service;
}
