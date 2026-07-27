// game-bot 啟動入口 + IPC + agent 觸發工具。
// 彙總點：組裝 BotTools（screenshot/input/vlm-locator/refs-store）→ 註冊 IPC → 註冊 game_bot_start 工具。
// 唯一碰 electron 的彙總模塊（ipcMain/BrowserWindow/app）；引擎本身不碰。

import * as fs from "fs";
import * as path from "path";
import { app, ipcMain, BrowserWindow, systemPreferences } from "electron";
import { toolRegistry } from "../orchestrator/tool-registry";
import { IPC } from "../../shared/ipc-channels";
import { parseRecipe } from "./script-parser";
import { runRecipe } from "./engine";
import type { BotTools } from "./bot-tools";
import type { GameRecipe } from "./types";
import {
  loadGameBotSettings,
  resolveGameBotVlmSettings,
  saveGameBotSettings,
  type GameBotSettings,
  type GameBotVlmSettings,
} from "./settings-store";
import { listRefs, readRef, refsDirPath } from "./refs-store";
import { captureScreen } from "./screenshot";
import * as input from "./input";
import * as vlm from "./vlm-locator";
import {
  inspectGameRuntime,
  isYaaglGameRunning,
  launchGameTarget,
  pressYaaglStartButton,
  readYaaglWindowBounds,
  yaaglStartPoint,
} from "./platform";

const LOG = "[GameBot]";

/** 掃描內置 game-recipes/ 目錄，返回腳本元數據列表。 */
export function listRecipes(): { id: string; name: string }[] {
  const dir = path.join(app.getAppPath(), "game-recipes");
  const result: { id: string; name: string }[] = [];
  try {
    if (!fs.existsSync(dir)) return result;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const id = f.replace(/\.(ya?ml)$/, "");
      const r = parseRecipe(fs.readFileSync(path.join(dir, f), "utf8"));
      result.push({ id, name: r.ok ? r.recipe.name : id });
    }
  } catch (err) {
    console.warn(LOG, "listRecipes 失敗:", err);
  }
  return result;
}

/** 讀腳本文件 → GameRecipe。 */
function loadRecipe(id: string): GameRecipe | null {
  const dir = path.join(app.getAppPath(), "game-recipes");
  for (const ext of [".yaml", ".yml"]) {
    const p = path.join(dir, id + ext);
    if (fs.existsSync(p)) {
      const r = parseRecipe(fs.readFileSync(p, "utf8"));
      return r.ok ? r.recipe : null;
    }
  }
  return null;
}

// ── 運行時狀態 ──
let runSignal: { aborted: boolean } | null = null;
let runningRecipe: string | null = null;

/** 組裝 BotTools 實現（注入引擎）。 */
function buildTools(settings: GameBotSettings, vlmConfig: GameBotVlmSettings): BotTools {
  const curRecipe = () => runningRecipe ?? settings.activeRecipe;
  return {
    launch: async (target) => {
      if (await isYaaglGameRunning()) {
        console.log(LOG, "StarRail.exe 已在執行，跳過 YAAGL 啟動");
        return;
      }
      await launchGameTarget(target);
    },
    yaaglStart: async () => {
      if (await isYaaglGameRunning()) {
        console.log(LOG, "StarRail.exe 已在執行，跳過 YAAGL 開始按鈕");
        return;
      }
      try {
        await pressYaaglStartButton(path.join(app.getAppPath(), "scripts", "yaagl-click-start.swift"));
        console.log(LOG, "已透過 macOS 輔助使用按下 YAAGL 開始遊戲");
      } catch (error) {
        console.warn(LOG, "YAAGL 輔助使用按鈕點擊失敗，改用視窗座標:", error);
        const bounds = await readYaaglWindowBounds(path.join(app.getAppPath(), "scripts", "yaagl-window-bounds.swift"));
        const point = yaaglStartPoint(bounds);
        console.log(LOG, "YAAGL 視窗與開始按鈕座標:", bounds, point);
        await input.click(point.x, point.y);
      }
    },
    screenshot: captureScreen,
    click: input.click,
    clickCenter: async () => {
      const s = await captureScreen();
      if (s) await input.clickCenter(s.width, s.height);
    },
    key: input.keyPress,
    locate: async (refName, targetDesc) => {
      const ref = readRef(curRecipe(), refName);
      const screen = await captureScreen();
      if (!screen || !ref) return null;
      return vlm.locate(vlmConfig, screen, [ref], targetDesc ?? "", screen.width, screen.height);
    },
    select: async (desc) => {
      const screen = await captureScreen();
      if (!screen) return null;
      return vlm.locate(vlmConfig, screen, [], desc, screen.width, screen.height);
    },
    check: async (ask, refName) => {
      const ref = refName ? (readRef(curRecipe(), refName) ?? undefined) : undefined;
      const screen = await captureScreen();
      if (!screen) return null;
      return vlm.check(vlmConfig, screen, ask, ref);
    },
    compare: async (refNames, ask) => {
      const refs = refNames
        .map((n) => readRef(curRecipe(), n))
        .filter((x): x is { base64: string; mime: string } => x !== null);
      const screen = await captureScreen();
      if (!screen) return null;
      return vlm.compare(vlmConfig, screen, refs, ask);
    },
  };
}

function broadcastProgress(info: { index: number; total: number; desc: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(IPC.GAME_BOT_PROGRESS, info); } catch { /* ignore */ }
    }
  }
}

/** 啟動代肝（設置面板 / agent 都調這個）。異步運行，不阻塞調用方。 */
export async function startGameBot(): Promise<{ ok: boolean; error?: string }> {
  if (runSignal) return { ok: false, error: "已有代肝任務在運行" };
  const settings = loadGameBotSettings();
  if (!settings.enabled) return { ok: false, error: "代肝未啟用（設置→插件→遊戲代肝 開啟開關）" };
  if (!settings.exePath) return { ok: false, error: "未配置遊戲／YAAGL 路徑" };
  const runtime = inspectGameRuntime(settings.exePath);
  if (!runtime.exists) return { ok: false, error: "找不到遊戲啟動程式: " + settings.exePath };
  if (runtime.runtime === "macos-yaagl") {
    // true 只會在使用者實際按下「開始代肝」時要求輔助使用權限。
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      return { ok: false, error: "macOS 尚未允許昔漣控制鍵盤滑鼠。請到 系統設定 → 隱私權與安全性 → 輔助使用，允許 Electron／昔漣後重試。" };
    }
    const screenStatus = systemPreferences.getMediaAccessStatus("screen");
    if (screenStatus === "denied" || screenStatus === "restricted") {
      return { ok: false, error: "macOS 尚未允許昔漣擷取畫面。請到 系統設定 → 隱私權與安全性 → 螢幕與系統錄音，允許 Electron／昔漣後重試。" };
    }
  }
  const vlmConfig = resolveGameBotVlmSettings(settings);
  if (!vlmConfig)
    return { ok: false, error: "沒有可用的視覺模型。請先在 API 設定啟用視覺模型，或在遊戲代肝填入 VLM（baseUrl/API Key/model）。" };
  const recipe = loadRecipe(settings.activeRecipe);
  if (!recipe) return { ok: false, error: "找不到腳本: " + settings.activeRecipe };

  runningRecipe = settings.activeRecipe;
  runSignal = { aborted: false };
  const tools = buildTools(settings, vlmConfig);

  void runRecipe(recipe, {
    tools,
    vars: { exe_path: settings.exePath, vlm_config: settings.vlm.model },
    onProgress: broadcastProgress,
    signal: runSignal,
  }).then((res) => {
    console.log(LOG, "代肝結束:", res.ok ? "成功" : "失敗(" + res.error + ")", res.completed + "/" + res.total);
    broadcastProgress({ index: -1, total: res.total, desc: res.ok ? "完成" : "失敗: " + (res.error ?? "") });
  }).catch((err) => {
    console.error(LOG, "代肝異常:", err);
    broadcastProgress({ index: -1, total: 0, desc: "異常: " + (err instanceof Error ? err.message : String(err)) });
  }).finally(() => {
    runSignal = null;
    runningRecipe = null;
  });
  // macOS 上若昔漣仍在前景，Wine/Metal 遊戲畫面可能被壓到背景，導致後續截圖
  // 只看到設定頁。延後隱藏以便 IPC 先把「已啟動」結果回傳給渲染端。
  if (runtime.runtime === "macos-yaagl") {
    setTimeout(() => {
      try { app.hide(); } catch { /* app may already be shutting down */ }
    }, 250);
  }
  return { ok: true };
}

/** 停止代肝。 */
export function stopGameBot(): { ok: boolean } {
  if (runSignal) runSignal.aborted = true;
  return { ok: true };
}

/** 註冊 IPC + game_bot_start 工具。app.whenReady 後調一次。 */
export function initGameBot(): void {
  ipcMain.handle(IPC.GAME_BOT_GET_CONFIG, () => loadGameBotSettings());
  ipcMain.handle(IPC.GAME_BOT_SAVE_CONFIG, (_e, patch: unknown) => {
    const saved = saveGameBotSettings(patch as Partial<GameBotSettings>);
    // enabled 開關同步到 agent 工具，關了 agent 就看不到/調不到
    toolRegistry.setEnabled("game_bot_start", saved.enabled);
    return saved;
  });
  ipcMain.handle(IPC.GAME_BOT_LIST_RECIPES, () => listRecipes());
  ipcMain.handle(IPC.GAME_BOT_LIST_REFS, (_e, recipeId: string) => listRefs(recipeId));
  ipcMain.handle(IPC.GAME_BOT_REFS_DIR, (_e, recipeId: string) => refsDirPath(recipeId));
  ipcMain.handle(IPC.GAME_BOT_START, () => startGameBot());
  ipcMain.handle(IPC.GAME_BOT_STOP, () => stopGameBot());

  // agent 觸發工具：用戶在聊天裡要代肝時調用。enabled 跟隨配置開關。
  const initialSettings = loadGameBotSettings();
  toolRegistry.register({
    id: "game_bot_start",
    name: "遊戲代肝",
    description:
      "啟動遊戲代肝，按預設腳本自動跑每日任務（如星穹鐵道）。\n\n" +
      "何時用：\n- 用戶說“幫我代肝”“跑一下日常”“清體力”“開始代肝”等\n\n" +
      "不要用於：\n- 用戶只是問代肝功能怎麼配置（引導去 設置 → 插件 → 遊戲代肝）\n\n" +
      "無需參數。調用後引擎獨立運行，進度實時回傳。返回啟動結果。",
    enabled: initialSettings.enabled,
    risk: "input-control",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const r = await startGameBot();
      if (r.ok) return "✅ 代肝已啟動，正在後臺運行，進度會實時更新。";
      return "[錯誤·配置] 代肝啟動失敗: " + (r.error ?? "未知錯誤");
    },
  });

  console.log(LOG, "已初始化：IPC + game_bot_start 工具，可用腳本:", listRecipes().map((r) => r.id).join(", ") || "(無)");
}
