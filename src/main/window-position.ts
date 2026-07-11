const MAX_WINDOW_COORDINATE = 1_000_000;

export function normalizeWindowCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.max(-MAX_WINDOW_COORDINATE, Math.min(MAX_WINDOW_COORDINATE, rounded));
}

export function normalizeWindowPosition(x: unknown, y: unknown): { x: number; y: number } | null {
  const normalizedX = normalizeWindowCoordinate(x);
  const normalizedY = normalizeWindowCoordinate(y);
  if (normalizedX === null || normalizedY === null) return null;
  return { x: normalizedX, y: normalizedY };
}
