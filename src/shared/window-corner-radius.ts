export const DEFAULT_WINDOW_CORNER_RADIUS = 24;
export const MIN_WINDOW_CORNER_RADIUS = 0;
export const MAX_WINDOW_CORNER_RADIUS = 40;

export function normalizeWindowCornerRadius(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_CORNER_RADIUS;
  return Math.max(
    MIN_WINDOW_CORNER_RADIUS,
    Math.min(MAX_WINDOW_CORNER_RADIUS, Math.round(numeric)),
  );
}
