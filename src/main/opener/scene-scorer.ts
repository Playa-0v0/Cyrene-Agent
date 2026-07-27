// 8 場景 baseScore 瞬間快照公式（0-100 連續值，無累積狀態）。
// finalScore = baseScore × affinity
import type { SceneId, OpenerState, UserStateSnapshot, WeatherSnapshot } from "./opener-types";
import { SCENE_CONFIGS } from "./scenes-config";

const MIN = (v: number, max: number) => Math.min(v / max, 1);

/**
 * 算單個場景的 finalScore = baseScore × affinity。
 * back_from_away 在 tick 內恆返回 0（事件驅動，由 runner 直通車處理）。
 */
export function scoreScene(
  scene: SceneId,
  snap: UserStateSnapshot,
  weather: WeatherSnapshot,
  state: OpenerState,
  now: number,
): number {
  const base = baseScore(scene, snap, weather, state, now);
  if (base <= 0) return 0;
  const aff = state.affinity[scene] ?? 1.0;
  return base * aff;
}

function isCoolingDown(scene: SceneId, state: OpenerState, now: number): boolean {
  const cfg = SCENE_CONFIGS.find(c => c.id === scene);
  if (!cfg) return true;
  const last = state.lastFiredAt[scene];
  if (last !== undefined && last !== null && now - last < cfg.cooldownMs) return true;
  return false;
}

function isTodayFired(scene: SceneId, state: OpenerState): boolean {
  const cfg = SCENE_CONFIGS.find(c => c.id === scene);
  if (!cfg?.todayFiredFlag) return false;
  return Boolean(state.todayFired[cfg.todayFiredFlag]);
}

function baseScore(
  scene: SceneId,
  snap: UserStateSnapshot,
  weather: WeatherSnapshot,
  state: OpenerState,
  now: number,
): number {
  if (isCoolingDown(scene, state, now)) return 0;
  if (isTodayFired(scene, state)) return 0;

  switch (scene) {
    case "morning":
      return (snap.hour >= 7 && snap.hour <= 10) ? 100 : 0;
    case "late_night":
      if (snap.hour < 23) return 0;
      return 50 + MIN(snap.keyboardAccumMin, 60) * 50;
    case "idle_daze":
      if (snap.hour < 9 || snap.hour > 18) return 0;
      if (snap.idleSec < 600) return 0;
      return 80 + MIN(snap.idleSec - 600, 1200) * 20;
    case "work_break":
      return MIN(snap.keyboardAccumMin, 120) * 100;
    case "back_from_away":
      return 0;
    case "rainy_day":
      if (!weather.isRaining) return 0;
      return 70 + MIN(weather.precip, 5) * 30;
    case "cold_drop":
      if (weather.tempDropFromYesterday <= 5) return 0;
      return 70 + MIN(weather.tempDropFromYesterday - 5, 10) * 30;
    case "sunny_day":
      if (!weather.isSunny || !weather.tempComfortable) return 0;
      return 70;
  }
}
