// game-bot 平台相容層。把 Windows exe 與 macOS YAAGL .app 的啟動差異
// 收斂在這裡，避免腳本與引擎知道作業系統細節。

import * as fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import { execFile } from "child_process";

export type GameRuntime = "windows-native" | "macos-yaagl" | "generic";

export interface GameRuntimeInfo {
  runtime: GameRuntime;
  target: string;
  exists: boolean;
  label: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpawnLike {
  (command: string, args: readonly string[], options: {
    detached: boolean;
    shell: false;
    stdio: "ignore";
  }): Pick<ChildProcess, "unref">;
}

export const DEFAULT_YAAGL_HSR_APP = "/Applications/Honkai Star Rail.app";

export function detectGameRuntime(target: string, platform = process.platform): GameRuntime {
  if (platform === "darwin" && /\.app\/?$/i.test(target.trim())) return "macos-yaagl";
  if (platform === "win32" && /\.exe$/i.test(target.trim())) return "windows-native";
  return "generic";
}

export function inspectGameRuntime(
  target: string,
  platform = process.platform,
  existsSync: (path: fs.PathLike) => boolean = fs.existsSync,
): GameRuntimeInfo {
  const runtime = detectGameRuntime(target, platform);
  return {
    runtime,
    target,
    exists: Boolean(target.trim()) && existsSync(target),
    label: runtime === "macos-yaagl"
      ? "macOS · YAAGL"
      : runtime === "windows-native" ? "Windows · 原生遊戲" : "自訂啟動程式",
  };
}

/**
 * 啟動遊戲目標。macOS 的 .app 必須交給 LaunchServices；直接 spawn bundle
 * 會得到 EACCES。其他平台保留原本直接啟動可執行檔的行為。
 */
export async function launchGameTarget(
  target: string,
  platform = process.platform,
  spawnImpl: SpawnLike = spawn,
): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("遊戲啟動路徑為空");

  const runtime = detectGameRuntime(trimmed, platform);
  const child = runtime === "macos-yaagl"
    ? spawnImpl("/usr/bin/open", ["-a", trimmed], { detached: true, shell: false, stdio: "ignore" })
    : spawnImpl(trimmed, [], { detached: true, shell: false, stdio: "ignore" });
  child.unref();
}

export function yaaglStartPoint(bounds: WindowBounds): { x: number; y: number } {
  // YAAGL 目前的主要啟動按鈕固定在內容區右下方。
  return {
    x: Math.round(bounds.x + bounds.width * 0.81),
    y: Math.round(bounds.y + bounds.height * 0.89),
  };
}

/** 由 CoreGraphics helper 取得 YAAGL 真實視窗邊界（跨 Retina 縮放與不同 Space）。 */
export async function readYaaglWindowBounds(helperPath: string): Promise<WindowBounds> {
  return await new Promise<WindowBounds>((resolve, reject) => {
    execFile("/usr/bin/swift", [helperPath], { timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new Error("找不到 YAAGL 主視窗"));
      try {
        const parsed = JSON.parse(stdout.trim()) as Partial<WindowBounds>;
        if (![parsed.x, parsed.y, parsed.width, parsed.height].every(Number.isFinite))
          throw new Error("invalid bounds");
        resolve(parsed as WindowBounds);
      } catch {
        reject(new Error("無法解析 YAAGL 視窗位置"));
      }
    });
  });
}

/** 用 macOS Accessibility 直接按 YAAGL 的「開始遊戲」，避免座標點擊被其他視窗吃掉。 */
export async function pressYaaglStartButton(helperPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/swift", [helperPath], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (!error && stdout.trim() === "clicked") return resolve();
      reject(new Error(stderr.trim() || "找不到 YAAGL 的開始遊戲按鈕"));
    });
  });
}

/** YAAGL 透過 Wine 啟動 StarRail.exe；已在執行時不可再次喚起啟動器。 */
export async function isYaaglGameRunning(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return await new Promise<boolean>((resolve) => {
    execFile("/usr/bin/pgrep", ["-f", "StarRail\\.exe"], { timeout: 3_000 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}
