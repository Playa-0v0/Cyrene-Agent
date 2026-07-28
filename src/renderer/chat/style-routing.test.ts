import fs from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
const markup = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("chat style routing contract", () => {
  it("sends selected style independently from chat or work mode", () => {
    expect(source).toContain("styleId: getCurrentStyleId()");
    expect(source).toContain('executionMode: isChatMode() ? "chat" : "work"');
    expect(source).not.toContain('return isChatMode() ? "chat" : style');
  });

  it("uses stable style ids in the dropdown", () => {
    for (const styleId of ["default", "lively", "healing", "focused", "sweet", "custom"]) {
      expect(markup).toContain(`data-value="${styleId}"`);
    }
  });

  it("renders Work and Chat as a direct segmented switch", () => {
    expect(markup).toContain('class="mode-switch"');
    expect(markup).toContain('data-mode-value="work"');
    expect(markup).toContain('data-mode-value="chat"');
    expect(markup).not.toContain('id="mode-dropdown"');
    expect(source).toContain('document.querySelectorAll(".mode-switch__option")');
  });
});
