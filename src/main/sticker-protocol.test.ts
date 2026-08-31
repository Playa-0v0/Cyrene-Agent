import * as path from "path";
import { describe, expect, it } from "vitest";
import { buildLocalStickerUrl, parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "./sticker-protocol";

describe("local sticker protocol helpers", () => {
  it("builds path-style URLs that parse back to the original file name", () => {
    const url = buildLocalStickerUrl("my cat.png");

    expect(url).toBe("local-sticker:///my%20cat.png");
    expect(parseLocalStickerFileFromUrl(url)).toBe("my cat.png");
  });

  it("keeps compatibility with legacy host-style sticker URLs", () => {
    expect(parseLocalStickerFileFromUrl("local-sticker://cat.png")).toBe("cat.png");
  });

  it("rejects traversal attempts and empty URLs", () => {
    expect(parseLocalStickerFileFromUrl("local-sticker:///%2e%2e/app-settings.json")).toBeNull();
    expect(parseLocalStickerFileFromUrl("local-sticker://..%2Fapp-settings.json")).toBeNull();
    expect(parseLocalStickerFileFromUrl("local-sticker:///")).toBeNull();
  });

  it("resolves files only inside the sticker directory", () => {
    const stickersDir = path.join("C:", "Users", "tester", "AppData", "Cyrene", "stickers");

    expect(resolveLocalStickerPath(stickersDir, "cat.png")).toBe(path.resolve(stickersDir, "cat.png"));
    expect(resolveLocalStickerPath(stickersDir, "../app-settings.json")).toBeNull();
  });
});
