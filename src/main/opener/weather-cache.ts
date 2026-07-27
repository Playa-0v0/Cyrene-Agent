// Open-Meteo 查詢 + 30min 緩存。免配置（spec: weatherSource open-meteo 默認）。
import type { WeatherSnapshot } from "./opener-types";

const CACHE_TTL_MS = 30 * 60 * 1000;
const EMPTY: WeatherSnapshot = {
  isRaining: false, precip: 0, temp: 0,
  tempDropFromYesterday: 0, isSunny: false, tempComfortable: false,
};

let cache: WeatherSnapshot | null = null;
let cacheAt = 0;
let cacheKey = "";
const coordCache = new Map<string, { lat: number; lon: number }>();

/**
 * 查天氣。需要傳 lat/lon（默認城市座標，由調用方從 user-default-city 解析或用上海兜底）。
 * 失敗返回 EMPTY（天氣場景 baseScore=0，不觸發）。
 */
export async function getWeather(lat: number, lon: number): Promise<WeatherSnapshot> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (cache && cacheKey === key && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,precipitation&daily=temperature_2m_max&past_days=1&forecast_days=1`;
    const resp = await fetch(url);
    if (!resp.ok) return EMPTY;
    const data = await resp.json() as {
      current?: { temperature_2m: number; weather_code: number; precipitation: number };
      daily?: { temperature_2m_max: number[] };
    };
    const cur = data.current;
    if (!cur) return EMPTY;
    // weather_code: 0=晴, 1-3=多雲, 45/48=霧, 51-67=雨, 71-77=雪, 80-82=陣雨, 95-99=雷暴
    const code = cur.weather_code;
    const isRaining = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95);
    const isSunny = code === 0 || code === 1;
    const temp = cur.temperature_2m;
    const tempComfortable = temp >= 18 && temp <= 26;

    let tempDrop = 0;
    if (data.daily?.temperature_2m_max && data.daily.temperature_2m_max.length >= 2) {
      const yesterday = data.daily.temperature_2m_max[0];
      const today = data.daily.temperature_2m_max[1];
      tempDrop = yesterday - today;
    }

    const snap: WeatherSnapshot = {
      isRaining,
      precip: cur.precipitation ?? 0,
      temp,
      tempDropFromYesterday: Math.max(0, tempDrop),
      isSunny,
      tempComfortable,
    };
    cache = snap;
    cacheAt = Date.now();
    cacheKey = key;
    return snap;
  } catch {
    return EMPTY;
  }
}

/** 以使用者設定的城市定位；無城市或定位失敗時不觸發天氣場景。 */
export async function getWeatherForCity(city: string): Promise<WeatherSnapshot> {
  const normalized = city.trim();
  if (!normalized) return { ...EMPTY };
  let coords = coordCache.get(normalized);
  if (!coords) {
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(normalized)}&count=1&language=zh&format=json`;
      const response = await fetch(url);
      if (!response.ok) return { ...EMPTY };
      const data = await response.json() as { results?: Array<{ latitude: number; longitude: number }> };
      const first = data.results?.[0];
      if (!first || !Number.isFinite(first.latitude) || !Number.isFinite(first.longitude)) return { ...EMPTY };
      coords = { lat: first.latitude, lon: first.longitude };
      coordCache.set(normalized, coords);
    } catch {
      return { ...EMPTY };
    }
  }
  return getWeather(coords.lat, coords.lon);
}
