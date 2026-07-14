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
});
