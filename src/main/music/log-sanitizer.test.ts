import { describe, it, expect } from "vitest";
import { sanitizeLogLine } from "./log-sanitizer";

describe("sanitizeLogLine", () => {
  it("redacts MUSIC_U cookie", () => {
    expect(sanitizeLogLine("MUSIC_U=abc123; domain=.music.163.com"))
      .toBe("MUSIC_U=<redacted>; domain=.music.163.com");
  });
  it("redacts csrf_token", () => {
    expect(sanitizeLogLine("csrf_token=xyz&type=1")).toBe("csrf_token=<redacted>&type=1");
  });
  it("redacts Authorization Bearer", () => {
    expect(sanitizeLogLine("Authorization: Bearer abc.def.ghi"))
      .toBe("Authorization: Bearer <redacted>");
  });
  it("redacts inline cookies dict", () => {
    expect(sanitizeLogLine('cookies={"MUSIC_U":"abc","__csrf":"x"}'))
      .toBe('cookies=<redacted>');
  });
  it("leaves normal text untouched", () => {
    expect(sanitizeLogLine("hello world")).toBe("hello world");
  });

  // === Edge cases added during code-quality review (commit ad9a13f) ===
  it("redacts JSON-style MUSIC_U without surrounding cookies={...}", () => {
    expect(sanitizeLogLine('"MUSIC_U":"abc"')).toBe('"MUSIC_U":"<redacted>"');
  });
  it("is case-insensitive for Authorization Bearer", () => {
    expect(sanitizeLogLine("authorization: bearer abc")).toBe("authorization: bearer <redacted>");
    expect(sanitizeLogLine("AUTHORIZATION: Bearer abc")).toBe("AUTHORIZATION: Bearer <redacted>");
  });
  it("preserves delimiter after __csrf value", () => {
    expect(sanitizeLogLine("__csrf=xyz&type=1")).toBe("__csrf=<redacted>&type=1");
  });
  it("preserves delimiter after Authorization Bearer value", () => {
    expect(sanitizeLogLine("Authorization: Bearer abc; next")).toBe("Authorization: Bearer <redacted>; next");
  });
  it("redacts generic API key fields", () => {
    expect(sanitizeLogLine("apiKey=secret-value; next")).toBe("apiKey=<redacted>; next");
    expect(sanitizeLogLine('"api_key":"secret-value"')).toBe('"api_key":"<redacted>"');
    expect(sanitizeLogLine("x-api-key: secret-value")).toBe("x-api-key: <redacted>");
  });
});
