import { isSupportedFontFileName } from "../shared/ui-font";

export function getUiFontResponseHeaders(fileName: string): Record<string, string> {
  const contentType = fileName.toLowerCase().endsWith(".otf")
    ? "font/otf"
    : "font/ttf";

  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

export function isSafeUiFontRequest(fileName: string): boolean {
  return isSupportedFontFileName(fileName);
}
