import type { OpenerRuntimeConfig, SceneId } from "./opener-types";

export function isQuietTime(now: Date, start: string, end: string): boolean {
  const toMinutes = (value: string): number => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  };
  const current = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(start);
  const until = toMinutes(end);
  if (from === until) return false;
  return from < until ? current >= from && current < until : current >= from || current < until;
}

export function isSceneEnabled(scene: SceneId, config: OpenerRuntimeConfig): boolean {
  if (scene === "morning" || scene === "late_night") return config.routineEnabled;
  if (scene === "rainy_day" || scene === "cold_drop" || scene === "sunny_day") return config.weatherEnabled;
  return config.breaksEnabled;
}
