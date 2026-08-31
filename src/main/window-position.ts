export const WINDOW_COORDINATE_LIMIT = 1_000_000;

export interface WindowPosition {
  x: number;
  y: number;
}

export function normalizeWindowCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.max(-WINDOW_COORDINATE_LIMIT, Math.min(WINDOW_COORDINATE_LIMIT, rounded));
}

export function normalizeWindowPosition(x: unknown, y: unknown): WindowPosition | null {
  const normalizedX = normalizeWindowCoordinate(x);
  const normalizedY = normalizeWindowCoordinate(y);
  if (normalizedX === null || normalizedY === null) return null;
  return { x: normalizedX, y: normalizedY };
}
