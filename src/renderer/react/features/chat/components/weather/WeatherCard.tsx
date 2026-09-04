import React, { useMemo, useState } from "react";
import { useTranslation } from "../../../../i18n";
import type { OpenMeteoWeatherData, AmapWeatherData, WeatherData } from "./weather-types";
import {
  mapWmoCode,
  mapAmapWeather,
  omWindDir,
  formatReportTime,
  formatDateText,
} from "./weather-utils";
import { WeatherIllustration } from "./WeatherIllustration";
import "./weather-card.css";

interface WeatherCardProps {
  data: WeatherData;
  /** Defaults to light. Parent can toggle and persist in its own state. */
  theme?: "light" | "dark";
}

const HumidityIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z" />
  </svg>
);

const WindDirIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M15.5 8.5l-2 5-5 2 2-5z" />
  </svg>
);

const WindSpeedIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.6 4.1A2 2 0 1 1 11 8H2M12.6 19.9A2 2 0 1 0 14 16H2M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2" />
  </svg>
);

const PrecipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 16.6A5 5 0 0 0 18 7a7 7 0 1 0-13.9 1.6A4.5 4.5 0 0 0 5.5 17H17" />
    <path d="M8 19v2M12 18v2M16 19v2" />
  </svg>
);

const PressureIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 15l3.5-3.5" />
    <path d="M20.2 15.5a8.5 8.5 0 1 0-16.4 0" />
  </svg>
);

const ThermometerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4a2 2 0 1 0-4 0v9.3a4.5 4.5 0 1 0 4 0z" />
  </svg>
);

export const WeatherCard: React.FC<WeatherCardProps> = ({ data, theme = "light" }) => {
  const { locale } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const dateText = useMemo(() => formatDateText(), [locale]);

  if (data.source === "open-meteo") {
    return <OpenMeteoCard data={data} theme={theme} dateText={dateText} advancedOpen={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} />;
  }

  return <AmapCard data={data} theme={theme} dateText={dateText} />;
};

interface OpenMeteoCardProps {
  data: OpenMeteoWeatherData;
  theme: "light" | "dark";
  dateText: string;
  advancedOpen: boolean;
  onToggle: () => void;
}

const OpenMeteoCard: React.FC<OpenMeteoCardProps> = ({
  data,
  theme,
  dateText,
  advancedOpen,
  onToggle,
}) => {
  const { t, locale } = useTranslation();
  const [category, weatherText] = useMemo(() => mapWmoCode(data.weatherCode), [data.weatherCode, locale]);

  return (
    <article className={`weather-card ${advancedOpen ? "advanced-open" : ""}`} data-theme={theme}>
      <header className="weather-card-header">
        <div className="weather-date-block">
          <span className="weather-date-text">{dateText}</span>
          <span className="weather-update-text">
            <span className="weather-update-dot" />
            <span>{t("weather.liveQuery")}</span>
          </span>
        </div>
        <div className="weather-location">
          <div className="weather-location-row">
            <span className="weather-province">{data.location.province}</span>
            <h1 className="weather-city">{data.location.city}</h1>
          </div>
          <span className="weather-source-tag">Open-Meteo</span>
        </div>
      </header>

      <section className="weather-current">
        <WeatherIllustration category={category} />
        <div className="weather-current-info">
          <div className="weather-temp-row">
            <span className="weather-temp-value">{data.temp}</span>
            <span className="weather-temp-unit">°C</span>
          </div>
          <div className="weather-desc">{weatherText}</div>
          <div className="weather-feels-like">{t("weather.feelsLike", { temp: data.feelsLike })}</div>
        </div>
      </section>

      <section className="weather-details-grid">
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <HumidityIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.humidity")}</span>
            <span className="weather-detail-value">{data.humidity}%</span>
          </div>
        </div>
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <WindDirIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.windDirection")}</span>
            <span className="weather-detail-value">{omWindDir(data.windDeg)}</span>
          </div>
        </div>
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <WindSpeedIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.windSpeed")}</span>
            <span className="weather-detail-value">{data.windSpeed} km/h</span>
          </div>
        </div>
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <PrecipIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.precipitation")}</span>
            <span className="weather-detail-value">{data.precipitation.toFixed(1)} mm</span>
          </div>
        </div>
      </section>

      <button
        type="button"
        className="weather-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={onToggle}
      >
        <svg
          className="weather-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span>{advancedOpen ? t("weather.advancedCollapse") : t("weather.advancedExpand")}</span>
        <span className="weather-toggle-hint">{t("weather.advancedHint")}</span>
      </button>

      <div className="weather-advanced-panel">
        <div className="weather-advanced-panel-inner">
          <div className="weather-advanced-content">
            <div className="weather-adv-item">
              <div className="weather-adv-icon">
                <PressureIcon />
              </div>
              <div className="weather-adv-text">
                <span className="weather-adv-label">{t("weather.pressure")}</span>
                <span className="weather-adv-value">{data.pressure.toFixed(1)} hPa</span>
              </div>
            </div>
            <div className="weather-adv-item">
              <div className="weather-adv-icon">
                <ThermometerIcon />
              </div>
              <div className="weather-adv-text">
                <span className="weather-adv-label">{t("weather.feelsLikeTemperature")}</span>
                <span className="weather-adv-value">{data.feelsLike}°C</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer className="weather-card-footer">{t("weather.sourceOpenMeteo")}</footer>
    </article>
  );
};

interface AmapCardProps {
  data: AmapWeatherData;
  theme: "light" | "dark";
  dateText: string;
}

const AmapCard: React.FC<AmapCardProps> = ({ data, theme, dateText }) => {
  const { t } = useTranslation();
  const category = useMemo(() => mapAmapWeather(data.weather), [data.weather]);

  return (
    <article className="weather-card" data-theme={theme}>
      <header className="weather-card-header">
        <div className="weather-date-block">
          <span className="weather-date-text">{dateText}</span>
          <span className="weather-update-text">
            <span className="weather-update-dot" />
            <span>{formatReportTime(data.reporttime)}</span>
          </span>
        </div>
        <div className="weather-location">
          <div className="weather-location-row">
            <span className="weather-province">{data.location.province}</span>
            <h1 className="weather-city">{data.location.city}</h1>
          </div>
          <span className="weather-source-tag">{t("weather.sourceAmapTag")}</span>
        </div>
      </header>

      <section className="weather-current">
        <WeatherIllustration category={category} />
        <div className="weather-current-info">
          <div className="weather-temp-row">
            <span className="weather-temp-value">{data.temp}</span>
            <span className="weather-temp-unit">°C</span>
          </div>
          <div className="weather-desc">{data.weather}</div>
          <div className="weather-feels-like">{t("weather.feelsLike", { temp: data.temp })}</div>
        </div>
      </section>

      <section className="weather-details-grid three">
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <HumidityIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.humidity")}</span>
            <span className="weather-detail-value">{data.humidity}%</span>
          </div>
        </div>
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <WindDirIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.windDirection")}</span>
            <span className="weather-detail-value">{t("weather.windDirectionValue", { dir: data.windDirection })}</span>
          </div>
        </div>
        <div className="weather-detail-item">
          <div className="weather-detail-icon">
            <WindSpeedIcon />
          </div>
          <div className="weather-detail-text">
            <span className="weather-detail-label">{t("weather.windPower")}</span>
            <span className="weather-detail-value">{t("weather.windPowerValue", { power: data.windPower })}</span>
          </div>
        </div>
      </section>

      <footer className="weather-card-footer">{t("weather.sourceAmap")}</footer>
    </article>
  );
};

export default WeatherCard;
