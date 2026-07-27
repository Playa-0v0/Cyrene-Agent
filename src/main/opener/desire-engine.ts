// Desire 累積 + 概率門 + affinity 反饋 + 持久化
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { OpenerState } from "./opener-types";
import {
  DESIRE_THRESHOLD, AFFINITY_MIN, AFFINITY_MAX,
  AFFINITY_ON_CLICK, AFFINITY_ON_IGNORE,
  RATE_MULT_MIN, RATE_MULT_MAX, RATE_MULT_ON_CLICK, RATE_MULT_ON_IGNORE,
} from "./scenes-config";

export function defaultState(): OpenerState {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    globalDesire: 0,
    affinity: {
      morning: 1.0, late_night: 1.0, idle_daze: 1.0, work_break: 1.0,
      back_from_away: 1.0, rainy_day: 1.0, cold_drop: 1.0, sunny_day: 1.0,
    },
    todayFired: {},
    lastFiredAt: {},
    recentItems: {},
    lastTriggeredScene: null,
    lastTriggeredAt: null,
    desireRateMultiplier: 1.0,
    lastDateStr: dateStr,
    dailyFireCount: 0,
  };
}

function getStatePath(): string {
  return path.join(app.getPath("userData"), "opener-state.json");
}

function rolloverIfNewDay(state: OpenerState): OpenerState {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (state.lastDateStr !== dateStr) {
    state.todayFired = {};
    state.dailyFireCount = 0;
    state.lastDateStr = dateStr;
  }
  return state;
}

export function loadState(): OpenerState {
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return defaultState();
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<OpenerState>;
    const base = defaultState();
    const merged: OpenerState = {
      ...base,
      ...raw,
      affinity: { ...base.affinity, ...(raw.affinity ?? {}) },
      todayFired: { ...(raw.todayFired ?? {}) },
      lastFiredAt: { ...(raw.lastFiredAt ?? {}) },
      recentItems: { ...(raw.recentItems ?? {}) },
    };
    return rolloverIfNewDay(merged);
  } catch {
    return defaultState();
  }
}

export function saveState(state: OpenerState): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[Opener] save state failed:", err);
  }
}

export function accumulateDesire(state: OpenerState, rate: number): OpenerState {
  const inc = rate * (state.desireRateMultiplier ?? 1.0);
  state.globalDesire = Math.min(100, state.globalDesire + inc);
  return state;
}

export function probabilityGate(state: OpenerState, randomFn: () => number = Math.random): boolean {
  if (state.globalDesire < DESIRE_THRESHOLD) return false;
  return randomFn() * 100 < state.globalDesire;
}

export function applyClickFeedback(state: OpenerState, sceneId: string): OpenerState {
  const cur = state.affinity[sceneId] ?? 1.0;
  state.affinity[sceneId] = Math.min(AFFINITY_MAX, cur * AFFINITY_ON_CLICK);
  state.desireRateMultiplier = Math.min(RATE_MULT_MAX, (state.desireRateMultiplier ?? 1.0) * RATE_MULT_ON_CLICK);
  state.globalDesire = Math.min(100, state.globalDesire + 20);
  return state;
}

export function applyIgnoreFeedback(state: OpenerState, sceneId: string): OpenerState {
  const cur = state.affinity[sceneId] ?? 1.0;
  state.affinity[sceneId] = Math.max(AFFINITY_MIN, cur * AFFINITY_ON_IGNORE);
  state.desireRateMultiplier = Math.max(RATE_MULT_MIN, (state.desireRateMultiplier ?? 1.0) * RATE_MULT_ON_IGNORE);
  return state;
}
