// Open-Meteo 查询 + 30min 缓存。免配置（spec: weatherSource open-meteo 默认）。
import type { WeatherSnapshot } from "./opener-types";

const CACHE_TTL_MS = 30 * 60 * 1000;
const EMPTY: WeatherSnapshot = {
  isRaining: false, precip: 0, temp: 0,
  tempDropFromYesterday: 0, isSunny: false, tempComfortable: false,
};

let cache: WeatherSnapshot | null = null;
let cacheAt = 0;

/**
 * 查天气。需要传 lat/lon（默认城市坐标，由调用方从 user-default-city 解析或用上海兜底）。
 * 失败返回 EMPTY（天气场景 baseScore=0，不触发）。
 */
export async function getWeather(lat: number, lon: number): Promise<WeatherSnapshot> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
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
    // weather_code: 0=晴, 1-3=多云, 45/48=雾, 51-67=雨, 71-77=雪, 80-82=阵雨, 95-99=雷暴
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
    return snap;
  } catch {
    return EMPTY;
  }
}
