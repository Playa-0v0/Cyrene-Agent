import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "RightInspector.css"), "utf8");

describe("RightInspector surface", () => {
  it("uses the shared pink installer motif", () => {
    const dom = new JSDOM(`<style>${stylesheet}</style>`);
    const rules = Array.from(dom.window.document.styleSheets[0].cssRules) as CSSStyleRule[];
    const inspector = rules.find((rule) => rule.selectorText === ".cy-right-inspector");

    expect(inspector).toBeDefined();
    expect(inspector?.style.backgroundColor).toBe("rgb(255, 251, 252)");
    expect(inspector?.style.backgroundImage).toContain("cyrene-surface-pattern.svg");
    expect(inspector?.style.backgroundPosition).toBe("center center");
    expect(inspector?.style.backgroundSize).toBe("cover");
  });
});
