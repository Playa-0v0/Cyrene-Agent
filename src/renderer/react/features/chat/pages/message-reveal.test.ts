import { describe, expect, it } from "vitest";
import { splitTextForReveal } from "./message-reveal";

describe("splitTextForReveal", () => {
  it("preserves the exact text while producing multiple reveal frames", () => {
    const text = "昔涟正在检查文件，然后会继续调用工具。";
    const chunks = splitTextForReveal(text, 8);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(8);
  });

  it("does not split surrogate pairs", () => {
    expect(splitTextForReveal("A🌸B", 3).join("")).toBe("A🌸B");
  });

  it("bounds the default reveal work for a long model message", () => {
    const chunks = splitTextForReveal("昔涟".repeat(500));

    expect(chunks.join("")).toBe("昔涟".repeat(500));
    expect(chunks.length).toBeLessThanOrEqual(24);
  });
});
