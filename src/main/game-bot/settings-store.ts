// settings-store —— game-bot 配置存取。userData/game-bot-settings.json。
// 照 index.ts 的 GeneralSettings 模式：load / save / normalize 三件套。
// 唯一碰 electron（app.getPath）。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { DEFAULT_YAAGL_HSR_APP } from "./platform";
import { revealSecrets } from "../security/secret-vault";

export interface GameBotVlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GameBotSettings {
  enabled: boolean;
  exePath: string;
  activeRecipe: string;   // 腳本文件名（去 .yaml）
  vlm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

const DEFAULTS: GameBotSettings = {
  enabled: false,
  exePath: process.platform === "darwin" ? DEFAULT_YAAGL_HSR_APP : "",
  activeRecipe: process.platform === "darwin" ? "star-rail-yaagl-daily" : "star-rail-daily",
  vlm: { baseUrl: "", apiKey: "", model: "" },
};

function filePath(): string {
  return path.join(app.getPath("userData"), "game-bot-settings.json");
}

function normalize(input: Partial<GameBotSettings> | null | undefined): GameBotSettings {
  const v = (input?.vlm ?? {}) as { baseUrl?: string; apiKey?: string; model?: string };
  return {
    enabled: Boolean(input?.enabled),
    exePath: typeof input?.exePath === "string" && input.exePath.trim()
      ? input.exePath.trim() : DEFAULTS.exePath,
    activeRecipe: typeof input?.activeRecipe === "string" && input.activeRecipe
      ? input.activeRecipe : DEFAULTS.activeRecipe,
    vlm: {
      baseUrl: typeof v.baseUrl === "string" ? v.baseUrl.trim() : "",
      apiKey: typeof v.apiKey === "string" ? v.apiKey.trim() : "",
      model: typeof v.model === "string" ? v.model.trim() : "",
    },
  };
}

export function loadGameBotSettings(): GameBotSettings {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    return normalize(JSON.parse(fs.readFileSync(p, "utf8")) as Partial<GameBotSettings>);
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGameBotSettings(patch: Partial<GameBotSettings>): GameBotSettings {
  const existing = loadGameBotSettings();
  const merged: Partial<GameBotSettings> = { ...existing, ...patch };
  if (patch.vlm) merged.vlm = { ...existing.vlm, ...patch.vlm };
  const final = normalize(merged);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(final, null, 2), "utf8");
  return final;
}

/**
 * 遊戲視覺設定留空時沿用昔漣已保存的視覺模型；若視覺模型設為同步，
 * 再沿用目前主模型。這讓使用者不必在遊戲插件重複保存 API Key。
 */
export function resolveGameBotVlmSettings(settings: GameBotSettings): GameBotVlmSettings | null {
  if (settings.vlm.baseUrl && settings.vlm.apiKey && settings.vlm.model) return settings.vlm;
  try {
    const modelPath = path.join(app.getPath("userData"), "model-settings.json");
    if (!fs.existsSync(modelPath)) return null;
    const modelSettings = revealSecrets(JSON.parse(fs.readFileSync(modelPath, "utf8"))) as {
      baseUrl?: unknown;
      apiKey?: unknown;
      model?: unknown;
      vision?: { syncWithMain?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown };
    };
    const vision = modelSettings.vision;
    const source = vision && vision.syncWithMain !== true ? vision : modelSettings;
    const resolved = {
      baseUrl: typeof source.baseUrl === "string" ? source.baseUrl.trim() : "",
      apiKey: typeof source.apiKey === "string" ? source.apiKey.trim() : "",
      model: typeof source.model === "string" ? source.model.trim() : "",
    };
    return resolved.baseUrl && resolved.apiKey && resolved.model ? resolved : null;
  } catch (error) {
    console.warn("[GameBot] 無法沿用昔漣視覺設定:", error);
    return null;
  }
}
