import { describe, expect, it } from "vitest";
import { parseSharedScreenFrame, shouldUseSharedScreen } from "./screen-context";

describe("shared screen context", () => {
  it("accepts supported bounded data URLs", () => {
    expect(parseSharedScreenFrame("data:image/jpeg;base64,YWJj")).toEqual({
      mime: "image/jpeg",
      base64: "YWJj",
    });
  });

  it("rejects unsupported and malformed payloads", () => {
    expect(parseSharedScreenFrame("data:image/svg+xml;base64,YWJj")).toBeNull();
    expect(parseSharedScreenFrame("not-an-image")).toBeNull();
    expect(parseSharedScreenFrame(null)).toBeNull();
  });

  it("only requests vision when speech refers to the shared screen", () => {
    expect(shouldUseSharedScreen("幫我看一下這個錯誤是什麼")).toBe(true);
    expect(shouldUseSharedScreen("你今天過得好嗎")).toBe(false);
  });
});
