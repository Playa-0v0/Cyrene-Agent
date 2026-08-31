export type WeatherCategory = "clear" | "cloudy" | "rain" | "snow" | "thunder";

export interface WeatherLocation {
  province: string;
  city: string;
}

export interface OpenMeteoWeatherData {
  source: "open-meteo";
  location: WeatherLocation;
  /** WMO weather code */
  weatherCode: number;
  /** temperature_2m in °C */
  temp: number;
  /** apparent_temperature in °C */
  feelsLike: number;
  /** relative_humidity_2m in % */
  humidity: number;
  /** wind_direction_10m in degrees */
  windDeg: number;
  /** wind_speed_10m in km/h */
  windSpeed: number;
  /** precipitation in mm */
  precipitation: number;
  /** surface_pressure in hPa */
  pressure: number;
}

export interface AmapWeatherData {
  source: "amap";
  location: WeatherLocation;
  /** Chinese weather description, e.g. "多云" */
  weather: string;
  /** temperature in °C */
  temp: number;
  /** humidity in % */
  humidity: number;
  /** e.g. "东南" */
  windDirection: string;
  /** e.g. "3" */
  windPower: string;
  /** reporttime like "2026-07-28 14:30:00" */
  reporttime: string;
}

export type WeatherData = OpenMeteoWeatherData | AmapWeatherData;
