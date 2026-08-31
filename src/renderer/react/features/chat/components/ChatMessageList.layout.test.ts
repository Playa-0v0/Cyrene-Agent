import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");

describe("chat reading width", () => {
  it("uses one responsive reading width for answers and run activity", () => {
    expect(stylesheet).toContain("--cy-message-reading-width: min(100%, clamp(640px, calc(100vw - 560px), 1120px))");
    expect(stylesheet).toMatch(/\.cy-message--assistant \.ant-bubble-body \{[\s\S]*max-width: var\(--cy-message-reading-width\)/);
    expect(stylesheet).toMatch(/\.cy-message--activity \{[\s\S]*width: var\(--cy-message-reading-width\)/);
  });

  it("uses the available chat width only when assistant bubbles are disabled", () => {
    expect(stylesheet).toMatch(
      /:root\[data-assistant-bubble="off"\] \.cy-message--assistant \.ant-bubble-body \{[\s\S]*width: calc\(100% - 54px\)[\s\S]*max-width: calc\(100% - 54px\)/,
    );
  });
});
