import React from "react";
import type { WeatherCategory } from "./weather-types";

interface WeatherIllustrationProps {
  category: WeatherCategory;
}

export const WeatherIllustration: React.FC<WeatherIllustrationProps> = ({ category }) => {
  return (
    <div className={`weather-illustration weather-${category}`}>
      <div className="sun">
        <div className="sun-rays">
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} />
          ))}
        </div>
        <div className="sun-core" />
      </div>
      <div className="cloud" />
      <div className="rain">
        <span />
        <span />
        <span />
      </div>
      <div className="snow">
        <span>❄</span>
        <span>❄</span>
        <span>❄</span>
      </div>
      <div className="bolt" />
    </div>
  );
};
