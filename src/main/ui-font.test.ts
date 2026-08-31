import { describe, expect, it } from "vitest";
import { DEFAULT_UI_FONT, isSupportedFontFileName, normalizeUiFont } from "../shared/ui-font";
import { getUiFontResponseHeaders, isSafeUiFontRequest } from "./ui-font-protocol";

describe("ui font settings", () => {
  it("uses Source Han Sans for missing or malformed values", () => {
    expect(normalizeUiFont(undefined)).toEqual(DEFAULT_UI_FONT);
    expect(normalizeUiFont({ kind: "custom", fileName: "../secret.ttf", displayName: "Oops" })).toEqual(DEFAULT_UI_FONT);
    expect(normalizeUiFont({ kind: "custom", fileName: "font.woff2", displayName: "Oops" })).toEqual(DEFAULT_UI_FONT);
  });

  it("keeps a valid imported font selection", () => {
    expect(normalizeUiFont({ kind: "custom", fileName: "custom-a1b2.otf", displayName: "可爱字体" })).toEqual({
      kind: "custom",
      fileName: "custom-a1b2.otf",
      displayName: "可爱字体",
    });
  });

  it("only permits safe TrueType and OpenType filenames", () => {
    expect(isSupportedFontFileName("font.ttf")).toBe(true);
    expect(isSupportedFontFileName("font.OTF")).toBe(true);
    expect(isSupportedFontFileName("..\\font.ttf")).toBe(false);
    expect(isSupportedFontFileName("font.ttf/other")).toBe(false);
  });

  it("serves imported fonts with a usable MIME type and CORS headers", () => {
    expect(getUiFontResponseHeaders("custom.ttf")).toMatchObject({
      "Content-Type": "font/ttf",
      "Access-Control-Allow-Origin": "*",
    });
    expect(getUiFontResponseHeaders("custom.otf")["Content-Type"]).toBe("font/otf");
    expect(isSafeUiFontRequest("../custom.ttf")).toBe(false);
  });
});
