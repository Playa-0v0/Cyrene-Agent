import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "react-root.css"), "utf8");

describe("chat workspace surface", () => {
  it("uses the installer motif on a softly pink reading surface", () => {
    const dom = new JSDOM(`
      <style>${stylesheet}</style>
      <main class="cy-page">
        <section class="cy-workspace is-empty"></section>
      </main>
    `, { pretendToBeVisual: true });
    const { document } = dom.window;
    const rootStyle = dom.window.getComputedStyle(document.documentElement);
    const rules = Array.from(document.styleSheets[0].cssRules) as CSSStyleRule[];
    const emptyPattern = rules.find((rule) => rule.selectorText === ".cy-workspace::before");
    const filledPattern = rules.find((rule) => rule.selectorText === ".cy-workspace.has-messages::before");

    expect(rootStyle.getPropertyValue("--cy-bg-page").trim()).toBe("#FAF4F8");
    expect(rootStyle.getPropertyValue("--cy-bg-workspace").trim()).toBe("#FFFBFC");
    expect(emptyPattern).toBeDefined();
    expect(emptyPattern?.style.backgroundImage).toContain("cyrene-surface-pattern.svg");
    expect(emptyPattern?.style.opacity).toBe("0.9");
    expect(emptyPattern?.style.pointerEvents).toBe("none");
    expect(filledPattern?.style.opacity).toBe("0.55");
  });
});
