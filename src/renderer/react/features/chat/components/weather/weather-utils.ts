import type { WeatherCategory } from "./weather-types";

export const WMO_MAP: Record<number, [WeatherCategory, string]> = {
  0: ["clear", "晴"],
  1: ["clear", "晴间多云"],
  2: ["cloudy", "多云"],
  3: ["cloudy", "阴"],
  45: ["cloudy", "雾"],
  48: ["cloudy", "雾凇"],
  51: ["rain", "小雨"],
  53: ["rain", "中雨"],
  55: ["rain", "大雨"],
  56: ["rain", "冻雨"],
  57: ["rain", "强冻雨"],
  61: ["rain", "小雨"],
  63: ["rain", "中雨"],
  65: ["rain", "大雨"],
  66: ["rain", "冻雨"],
  67: ["rain", "强冻雨"],
  71: ["snow", "小雪"],
  73: ["snow", "中雪"],
  75: ["snow", "大雪"],
  77: ["snow", "雪粒"],
  80: ["rain", "阵雨"],
  81: ["rain", "强阵雨"],
  82: ["rain", "暴雨"],
  85: ["snow", "阵雪"],
  86: ["snow", "强阵雪"],
  95: ["thunder", "雷暴"],
  96: ["thunder", "雷暴伴冰雹"],
  99: ["thunder", "强雷暴伴冰雹"],
};

export function mapWmoCode(code: number): [WeatherCategory, string] {
  return WMO_MAP[code] ?? ["cloudy", "未知天气"];
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

export function omWindDir(deg: number): string {
  const dirs = [
    "北",
    "东北偏北",
    "东北",
    "东北偏东",
    "东",
    "东南偏东",
    "东南",
    "东南偏南",
    "南",
    "西南偏南",
    "西南",
    "西南偏西",
    "西",
    "西北偏西",
    "西北",
    "西北偏北",
  ];
  return dirs[Math.round(deg / 22.5) % 16] + "风";
}

export function formatReportTime(reporttime: string): string {
  const timePart = reporttime.split(" ")[1] ?? "";
  return timePart.slice(0, 5) + " 更新";
}

export function formatDateText(date = new Date()): string {
  const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
  return `${date.getMonth() + 1}月${date.getDate()}日 星期${weekNames[date.getDay()]}`;
}
