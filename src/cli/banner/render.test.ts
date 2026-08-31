import { describe, expect, it } from "vitest";
import { CYRENE_LOGO, CYRENE_LOGO_TEXT } from "./ascii";
import { BANNER_LINES, ABOUT_LINES, MIN_BANNER_WIDTH } from "./text";
import { renderBanner, renderAbout, resolveWidth } from "./render";

describe("ascii", () => {
  it("CYRENE_LOGO is exactly six non-empty lines", () => {
    expect(CYRENE_LOGO).toHaveLength(6);
    for (const line of CYRENE_LOGO) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("CYRENE_LOGO_TEXT joins with single newlines", () => {
    expect(CYRENE_LOGO_TEXT.split("\n")).toHaveLength(6);
  });
});

describe("render", () => {
  it("renderBanner starts with the six logo lines, a blank line, and a framed box", () => {
    const out = renderBanner({ width: 64 });
    const lines = out.split("\n");
    // 6 logo + 1 blank + 3 box rows (top, 1 line, bottom would be 5 for 3 text lines)
    expect(lines.slice(0, 6).join("\n")).toBe(CYRENE_LOGO_TEXT);
    expect(lines[6]).toBe("");
    // box top
    expect(lines[7].startsWith("╭")).toBe(true);
    expect(lines[7].endsWith("╮")).toBe(true);
    // box bottom
    const last = lines[lines.length - 1];
    expect(last.startsWith("╰")).toBe(true);
    expect(last.endsWith("╯")).toBe(true);
  });

  it("renderBanner contains the brand quote", () => {
    expect(renderBanner({ width: 64 })).toContain('"Every memory has a place."');
  });

  it("renderBanner contains all three BANNER_LINES", () => {
    const out = renderBanner({ width: 64 });
    for (const line of BANNER_LINES) {
      expect(out).toContain(line);
    }
  });

  it("every line of renderBanner({width:64}) is at most 64 visible columns", () => {
    const out = renderBanner({ width: 64 });
    for (const line of out.split("\n")) {
      expect(Array.from(line).length).toBeLessThanOrEqual(64);
    }
  });

  it("clamps a too-small width up to MIN_BANNER_WIDTH", () => {
    const out = renderBanner({ width: 20 });
    for (const line of out.split("\n")) {
      expect(Array.from(line).length).toBeLessThanOrEqual(MIN_BANNER_WIDTH);
    }
  });

  it("renderAbout includes the GitHub URL", () => {
    expect(renderAbout({ width: 64 })).toContain(
      "https://github.com/Playa-0v0/Cyrene-Agent",
    );
  });

  it("renderAbout contains all ABOUT_LINES", () => {
    const out = renderAbout({ width: 64 });
    for (const line of ABOUT_LINES) {
      expect(out).toContain(line);
    }
  });

  it("resolveWidth clamps to MIN_BANNER_WIDTH when given a smaller explicit width", () => {
    expect(resolveWidth({ width: 10 })).toBe(MIN_BANNER_WIDTH);
  });

  it("resolveWidth uses the explicit width when >= MIN_BANNER_WIDTH", () => {
    expect(resolveWidth({ width: 80 })).toBe(80);
  });
});
