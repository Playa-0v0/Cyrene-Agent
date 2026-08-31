import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  normalizeWindowCornerRadius,
} from "../../shared/window-corner-radius";

declare global {
  interface Window {
    cyreneWindowAppearance?: {
      getCornerRadius: () => Promise<number>;
      onCornerRadiusChanged: (callback: (radius: number) => void) => () => void;
    };
  }
}

export function applyWindowCornerRadius(value: unknown): number {
  const radius = normalizeWindowCornerRadius(value);
  document.documentElement.style.setProperty("--cy-window-radius", `${radius}px`);
  return radius;
}

applyWindowCornerRadius(DEFAULT_WINDOW_CORNER_RADIUS);

void window.cyreneWindowAppearance?.getCornerRadius()
  .then(applyWindowCornerRadius)
  .catch(() => applyWindowCornerRadius(DEFAULT_WINDOW_CORNER_RADIUS));

window.cyreneWindowAppearance?.onCornerRadiusChanged(applyWindowCornerRadius);
