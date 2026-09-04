import { t } from "../../../../i18n";
import type { WeatherCategory } from "./weather-types";

/** WMO 天气码 → [分类, i18n key]，展示文案经 mapWmoCode 内的 t() 取值。 */
export const WMO_MAP: Record<number, [WeatherCategory, string]> = {
  0: ["clear", "weather.wmoClear"],
  1: ["clear", "weather.wmoMostlyClear"],
  2: ["cloudy", "weather.wmoPartlyCloudy"],
  3: ["cloudy", "weather.wmoOvercast"],
  45: ["cloudy", "weather.wmoFog"],
  48: ["cloudy", "weather.wmoRimeFog"],
  51: ["rain", "weather.wmoLightRain"],
  53: ["rain", "weather.wmoModerateRain"],
  55: ["rain", "weather.wmoHeavyRain"],
  56: ["rain", "weather.wmoFreezingRain"],
  57: ["rain", "weather.wmoHeavyFreezingRain"],
  61: ["rain", "weather.wmoLightRain"],
  63: ["rain", "weather.wmoModerateRain"],
  65: ["rain", "weather.wmoHeavyRain"],
  66: ["rain", "weather.wmoFreezingRain"],
  67: ["rain", "weather.wmoHeavyFreezingRain"],
  71: ["snow", "weather.wmoLightSnow"],
  73: ["snow", "weather.wmoModerateSnow"],
  75: ["snow", "weather.wmoHeavySnow"],
  77: ["snow", "weather.wmoSnowGrains"],
  80: ["rain", "weather.wmoShowers"],
  81: ["rain", "weather.wmoHeavyShowers"],
  82: ["rain", "weather.wmoViolentShowers"],
  85: ["snow", "weather.wmoSnowShowers"],
  86: ["snow", "weather.wmoHeavySnowShowers"],
  95: ["thunder", "weather.wmoThunderstorm"],
  96: ["thunder", "weather.wmoThunderstormHail"],
  99: ["thunder", "weather.wmoHeavyThunderstormHail"],
};

export function mapWmoCode(code: number): [WeatherCategory, string] {
  const entry = WMO_MAP[code];
  return entry ? [entry[0], t(entry[1])] : ["cloudy", t("weather.unknown")];
}

export const AMAP_MAP: Record<string, WeatherCategory> = {
  晴: "clear",
  多云: "cloudy",
  阴: "cloudy",
  雾: "cloudy",
  霾: "cloudy",
  扬沙: "cloudy",
  浮尘: "cloudy",
  沙尘暴: "cloudy",
  强沙尘暴: "cloudy",
  小雨: "rain",
  中雨: "rain",
  大雨: "rain",
  暴雨: "rain",
  阵雨: "rain",
  小雪: "snow",
  中雪: "snow",
  大雪: "snow",
  暴雪: "snow",
  雨夹雪: "snow",
  阵雪: "snow",
  雷阵雨: "thunder",
  雷阵雨并伴有冰雹: "thunder",
};

export function mapAmapWeather(text: string): WeatherCategory {
  return AMAP_MAP[text] ?? "cloudy";
}

const WIND_DIR_KEYS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export function omWindDir(deg: number): string {
  return t(`weather.windDir${WIND_DIR_KEYS[Math.round(deg / 22.5) % 16]}`);
}

export function formatReportTime(reporttime: string): string {
  const timePart = reporttime.split(" ")[1] ?? "";
  return t("weather.updatedAt", { time: timePart.slice(0, 5) });
}

export function formatDateText(date = new Date()): string {
  return t("weather.dateText", {
    month: date.getMonth() + 1,
    day: date.getDate(),
    week: t(`weather.weekday${date.getDay()}`),
  });
}
