export type UiFont =
  | { kind: "source-han" }
  | { kind: "custom"; fileName: string; displayName: string };

export const DEFAULT_UI_FONT: UiFont = { kind: "source-han" };

const FONT_FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:ttf|otf)$/i;

export function normalizeUiFont(value: unknown): UiFont {
  if (!value || typeof value !== "object") return DEFAULT_UI_FONT;
  const input = value as { kind?: unknown; fileName?: unknown; displayName?: unknown };
  if (
    input.kind !== "custom"
    || typeof input.fileName !== "string"
    || !FONT_FILE_NAME.test(input.fileName)
    || typeof input.displayName !== "string"
    || !input.displayName.trim()
  ) return DEFAULT_UI_FONT;

  return {
    kind: "custom",
    fileName: input.fileName,
    displayName: input.displayName.trim().slice(0, 80),
  };
}

export function isSupportedFontFileName(fileName: string): boolean {
  return FONT_FILE_NAME.test(fileName);
}
