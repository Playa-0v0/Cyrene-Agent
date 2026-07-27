// tick 主循環 + 事件打斷 + 選文案 + 觸發 LIVE2D_SHOW_BUBBLE + 響應窗口 + 反饋閉環
import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { SCENE_CONFIGS, DESIRE_RATE, RESPONSE_WINDOW_MS } from "./scenes-config";
import { getOpenerPackDir, hasExternalVoicePack, loadManifest, pickItem, resolveAudioPath, readWavDurationMs, readWavBase64 } from "./opener-pack-store";
import { getWeatherForCity } from "./weather-cache";
import { snapshot } from "./user-state-sensor";
import { loadState, saveState, accumulateDesire, probabilityGate, applyClickFeedback, applyIgnoreFeedback } from "./desire-engine";
import { scoreScene } from "./scene-scorer";
import { isQuietTime, isSceneEnabled } from "./opener-policy";
import type { OpenerRuntimeConfig, OpenerState, OpenerStatus, SceneId, ShowBubblePayload, WeatherSnapshot } from "./opener-types";

const TICK_MS = 60_000;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let responseTimer: ReturnType<typeof setTimeout> | null = null;
let live2dWindow: BrowserWindow | null = null;
let manifest = loadManifest();
let weatherCachedHour = -1;
let runtimeConfig: OpenerRuntimeConfig = {
  mode: "normal",
  quietStart: "23:00",
  quietEnd: "07:00",
  dailyLimit: 4,
  routineEnabled: true,
  breaksEnabled: true,
  weatherEnabled: true,
  city: "",
};

export function setLive2dWindow(win: BrowserWindow | null): void {
  live2dWindow = win;
}

export function reloadManifest(): void {
  manifest = loadManifest();
}

export function configureOpener(config: OpenerRuntimeConfig): void {
  runtimeConfig = config;
  manifest = loadManifest();
}

export function startOpener(config: OpenerRuntimeConfig): void {
  stopOpener();
  configureOpener(config);
  if (!manifest) {
    console.warn("[Opener] manifest 未配置，不啟動");
    return;
  }
  const rate = DESIRE_RATE[config.mode];
  tickTimer = setInterval(() => void tick(rate), TICK_MS);
  console.log(`[Opener] 啟動，mode=${config.mode} rate=${rate}/min dailyLimit=${config.dailyLimit}`);
}

export function stopOpener(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
  console.log("[Opener] 停止");
}

async function tick(rate: number): Promise<void> {
  let state = loadState();
  const snap = snapshot();
  const now = Date.now();

  if (isQuietTime(new Date(now), runtimeConfig.quietStart, runtimeConfig.quietEnd)) {
    saveState(state);
    return;
  }
  if (state.dailyFireCount >= runtimeConfig.dailyLimit) {
    saveState(state);
    return;
  }

  // 1. 事件打斷直通車：離開後恢復
  if (snap.mouseResumeEvent && isSceneEnabled("back_from_away", runtimeConfig)) {
    state.globalDesire = 100;
    saveState(state);
    await tryFire("back_from_away", snap, state, now);
    return;
  }

  // 2. Desire 累積
  state = accumulateDesire(state, rate);

  // 3. 概率門
  if (!probabilityGate(state)) {
    saveState(state);
    return;
  }

  // 4. 瞬間快照打分
  const weather = await getWeatherIfNeeded(snap.hour);
  const candidates: Array<{ scene: SceneId; score: number }> = [];
  for (const cfg of SCENE_CONFIGS) {
    if (!isSceneEnabled(cfg.id, runtimeConfig)) continue;
    const score = scoreScene(cfg.id, snap, weather, state, now);
    if (score > 0) candidates.push({ scene: cfg.id, score });
  }

  // 5. 決策
  if (candidates.length === 0) {
    state.globalDesire = Math.max(0, state.globalDesire - 10);
    saveState(state);
    return;
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0].score;
  const ties = candidates.filter(c => c.score >= top * 0.95);
  const winner = ties[Math.floor(Math.random() * ties.length)];

  saveState(state);
  await tryFire(winner.scene, snap, state, now);
}

async function getWeatherIfNeeded(hour: number): Promise<WeatherSnapshot> {
  const empty: WeatherSnapshot = { isRaining:false, precip:0, temp:0, tempDropFromYesterday:0, isSunny:false, tempComfortable:false };
  if (hour < 6 || hour > 22) return empty;
  if (hour === weatherCachedHour) {
    return getWeatherForCity(runtimeConfig.city);
  }
  weatherCachedHour = hour;
  return getWeatherForCity(runtimeConfig.city);
}

async function tryFire(scene: SceneId, snap: { hour: number }, state: OpenerState, now: number): Promise<void> {
  if (!manifest) return;
  const pack = manifest.packs[scene];
  if (!pack) return;

  const recent = state.recentItems[scene] ?? [];
  const item = pickItem(pack.items, snap.hour, recent);
  if (!item) {
    console.warn(`[Opener] 場景 ${scene} 無可用文案`);
    return;
  }

  const wavPath = item.audio ? resolveAudioPath(item.audio) : null;
  const durationMs = wavPath ? readWavDurationMs(wavPath) : 0;
  const audioBase64 = wavPath ? readWavBase64(wavPath) : "";

  const cfg = SCENE_CONFIGS.find(c => c.id === scene)!;
  if (cfg.todayFiredFlag) state.todayFired[cfg.todayFiredFlag] = true;
  state.lastFiredAt[scene] = now;
  const newRecent = [item.id, ...recent].slice(0, Math.max(cfg.recentAvoidN, 1) + 2);
  state.recentItems[scene] = newRecent;
  state.lastTriggeredScene = scene;
  state.lastTriggeredAt = now;
  state.globalDesire = 0;
  state.dailyFireCount += 1;
  saveState(state);

  const payload: ShowBubblePayload = {
    text: item.text,
    audioBase64,
    format: "wav",
    durationMs,
    sceneId: scene,
    itemId: item.id,
  };
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.webContents.send(IPC.LIVE2D_SHOW_BUBBLE, payload);
  }

  startResponseWindow(scene, now);
}

export function getOpenerStatus(): OpenerStatus {
  manifest = loadManifest();
  const state = loadState();
  const packs = manifest ? Object.values(manifest.packs) : [];
  const items = packs.flatMap(pack => pack.items);
  return {
    running: tickTimer !== null,
    packSource: hasExternalVoicePack() ? "voice-pack" : "built-in-text",
    packDir: getOpenerPackDir(),
    sceneCount: packs.length,
    audioItemCount: items.filter(item => Boolean(item.audio && resolveAudioPath(item.audio))).length,
    textItemCount: items.length,
    dailyFireCount: state.dailyFireCount,
    dailyLimit: runtimeConfig.dailyLimit,
    desire: Math.round(state.globalDesire),
    lastScene: state.lastTriggeredScene,
    lastTriggeredAt: state.lastTriggeredAt,
    city: runtimeConfig.city,
  };
}

function startResponseWindow(scene: SceneId, firedAt: number): void {
  if (responseTimer) clearTimeout(responseTimer);
  responseTimer = setTimeout(() => {
    let state = loadState();
    if (state.lastTriggeredScene === scene && state.lastTriggeredAt === firedAt) {
      state = applyIgnoreFeedback(state, scene);
      saveState(state);
      console.log(`[Opener] ${scene} 被忽略`);
    }
    responseTimer = null;
  }, RESPONSE_WINDOW_MS);
}

export function handleBubbleClick(sceneId: string, itemId: string): void {
  let state = loadState();
  if (state.lastTriggeredScene !== sceneId) return;
  let state2 = applyClickFeedback(state, sceneId);
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
  saveState(state2);
  console.log(`[Opener] ${sceneId} 被接話（點氣泡）`);
}

export function handleChatWindowOpened(): void {
  if (!responseTimer) return;
  let state = loadState();
  const scene = state.lastTriggeredScene;
  if (!scene) return;
  let state2 = applyClickFeedback(state, scene);
  clearTimeout(responseTimer);
  responseTimer = null;
  saveState(state2);
  console.log(`[Opener] ${scene} 被接話（打開 chat）`);
}

/** 顯示由 Agent 即時生成的主動陪伴內容；audioBase64 為空時只顯示文字氣泡。 */
export function showGeneratedBubble(
  text: string,
  audioBase64 = "",
  format: "wav" | "mp3" = "mp3",
  durationMs = 0,
  sceneId = "daily-ritual",
): boolean {
  const normalized = text.trim();
  if (!normalized || !live2dWindow || live2dWindow.isDestroyed()) return false;
  const payload: ShowBubblePayload = {
    text: normalized,
    audioBase64,
    format,
    durationMs: durationMs > 0 ? durationMs : Math.max(1800, Math.min(18000, normalized.length * 180)),
    sceneId,
    itemId: `${sceneId}-${Date.now()}`,
  };
  live2dWindow.webContents.send(IPC.LIVE2D_SHOW_BUBBLE, payload);
  return true;
}

/** 手動測試：直接讀第一條可用 wav 發氣泡，不走 Desire/state 邏輯。 */
export async function testFire(requestedScene?: string): Promise<{ ok: boolean; message: string; sceneId?: string; itemId?: string }> {
  if (!manifest || !live2dWindow || live2dWindow.isDestroyed()) {
    console.warn("[Opener] testFire: manifest 或桌寵窗口未就緒");
    return { ok: false, message: "桌寵窗口尚未就緒，請先顯示桌寵再試。" };
  }
  for (const [sceneId, pack] of Object.entries(manifest.packs)) {
    if (requestedScene && sceneId !== requestedScene) continue;
    for (const item of pack.items) {
      const wav = item.audio ? resolveAudioPath(item.audio) : null;
      const payload: ShowBubblePayload = {
        text: item.text,
        audioBase64: wav ? readWavBase64(wav) : "",
        format: "wav",
        durationMs: wav ? readWavDurationMs(wav) : 0,
        sceneId,
        itemId: item.id,
      };
      live2dWindow.webContents.send(IPC.LIVE2D_SHOW_BUBBLE, payload);
      console.log(`[Opener] testFire: ${sceneId}/${item.id}`);
      return { ok: true, message: wav ? "語音氣泡已送出。" : "文字氣泡已送出；安裝語音包後會同時播放語音。", sceneId, itemId: item.id };
    }
  }
  console.warn("[Opener] testFire: 無可用音頻");
  return { ok: false, message: requestedScene ? "這個場景沒有可用文案。" : "沒有可用的主動開口文案。" };
}
