import { describe, expect, it } from "vitest";
import { markdownToSpeechText, SPEECH_TEXT_CONVERTER_VERSION } from "./markdown-to-speech-text";

describe("markdownToSpeechText", () => {
  it("keeps prose and removes visual markdown markers", () => {
    const result = markdownToSpeechText("## 状态更新\n\n这是 **重要** 的 *说明*。", {});
    expect(result.text).toBe("状态更新。 这是重要的说明。");
    expect(result.converterVersion).toBe(SPEECH_TEXT_CONVERTER_VERSION);
  });

  it("reads link labels without reading URLs", () => {
    const result = markdownToSpeechText(
      "请查看 [官方文档](https://example.com/very/long/path) 和 https://example.com/raw。",
      {},
    );
    expect(result.text).toContain("官方文档");
    expect(result.text).toContain("这里有一个链接");
    expect(result.text).not.toContain("https");
    expect(result.text).not.toContain("example.com");
  });

  it("describes images and code blocks without reading their source", () => {
    const result = markdownToSpeechText(
      "![函数图像](plot.png)\n\n```ts\nconst secret = 'do not read';\n```",
      {},
    );
    expect(result.text).toContain("图片：函数图像");
    expect(result.text).toContain("伙伴，请查看下面的 TypeScript 代码块");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("do not read");
  });

  it("uses the preferred address for visual-only code, formula, and table prompts", () => {
    const code = markdownToSpeechText("```ts\nconst value = 1;\n```", { preferredAddress: "P宝" });
    const formula = markdownToSpeechText(
      "$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$",
      { preferredAddress: "P宝" },
    );
    const table = markdownToSpeechText(
      "|列|\n|-|\n|1|\n|2|\n|3|\n|4|\n|5|",
      { preferredAddress: "P宝", maxTableRows: 4 },
    );

    expect(code.text).toContain("P宝，请查看下面的 TypeScript 代码块");
    expect(formula.text).toContain("P宝，请查看下面的公式");
    expect(table.text).toContain("P宝，请查看下面的表格");
  });

  it("falls back to 伙伴 when the preferred address is blank", () => {
    const result = markdownToSpeechText("```ts\nconst value = 1;\n```", { preferredAddress: "   " });
    expect(result.text).toContain("伙伴，请查看下面的 TypeScript 代码块");
  });

  it("keeps short inline code but replaces paths and hashes", () => {
    const result = markdownToSpeechText(
      "调用 `useState`，打开 C:\\Users\\Cyrene\\project\\index.ts，提交 0123456789abcdef0123456789abcdef01234567。",
      {},
    );
    expect(result.text).toContain("use State");
    expect(result.text).toContain("一个文件路径");
    expect(result.text).toContain("一个标识符");
    expect(result.text).not.toContain("Cyrene\\project");
  });

  it("numbers list items and marks blockquotes", () => {
    const result = markdownToSpeechText("> 注意安全。\n\n- 苹果\n- 香蕉", {});
    expect(result.text).toContain("引用内容：注意安全");
    expect(result.text).toContain("第一项，苹果");
    expect(result.text).toContain("第二项，香蕉");
  });

  it("reads small tables by row and summarizes large tables", () => {
    const small = markdownToSpeechText("|姓名|分数|\n|-|-|\n|昔涟|100|\n|伙伴|99|", {});
    expect(small.text).toContain("第一行，姓名是昔涟，分数是100");
    expect(small.text).toContain("第二行，姓名是伙伴，分数是99");

    const large = markdownToSpeechText("|列|\n|-|\n|1|\n|2|\n|3|\n|4|\n|5|", { maxTableRows: 4 });
    expect(large.text).toContain("伙伴，请查看下面的表格");
    expect(large.warnings).toContain("large-table-skipped");
  });

  it("converts common inline Latex into spoken Chinese", () => {
    const result = markdownToSpeechText("公式为 $E=mc^2$，以及 $\\frac{a}{b}$ 和 $\\sqrt{x}$。", {});
    expect(result.text).toContain("E 等于 m c 的平方");
    expect(result.text).toContain("b 分之 a");
    expect(result.text).toContain("根号 x");
  });

  it("summarizes complex formulas in default mode and keeps details in learn mode", () => {
    const markdown = "结果是 $$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$。";
    const normal = markdownToSpeechText(markdown, {});
    expect(normal.text).toContain("伙伴，请查看下面的公式");
    expect(normal.warnings).toContain("complex-formula-skipped");

    const learn = markdownToSpeechText(markdown, { mode: "learn" });
    expect(learn.text).toContain("积分");
    expect(learn.text).not.toContain("请查看下面的公式");
  });

  it("replaces musical note symbols with a sentence-ending pause", () => {
    const result = markdownToSpeechText("下午好呀伙伴♪ 人家呢…倒是不用吃饭。", {});
    expect(result.text).toContain("下午好呀伙伴。");
    expect(result.text).not.toContain("♪");
  });
});
