import { describe, expect, it } from "vitest";
import { buildStickerEmbeddingQuery, extractStickerEmbeddingText } from "./sticker-query";

describe("sticker embedding query", () => {
  it("keeps only natural language from Markdown while excluding code and math", () => {
    const text = [
      "## 太好了，问题解决啦！",
      "```ts",
      "const mood = 'happy';",
      "```",
      "行内代码 `const ignored = true` 也不能参与。",
      "行内公式 $E = mc^2$ 与块公式：",
      "$$\\int_0^1 x^2 dx$$",
      "[查看文档](https://example.com/internal-only)",
    ].join("\n");

    // 新实现是纯正则 stripper：丢掉 fenced code / 行内 code / 数学公式 / 图片 / 链接 URL，
    // 但保留 markdown 结构标记（## 标题、[链接方括号]）作为噪声 token — 对情绪类 fuzzy
    // embedding 匹配影响极小，且省去维护一整套 markdown 解析规则的负担。
    expect(extractStickerEmbeddingText(text)).toBe(
      "## 太好了，问题解决啦！ 行内代码 也不能参与。 行内公式 与块公式： [查看文档]",
    );
  });

  it("does not send formula or code content to the embedding provider query", () => {
    expect(buildStickerEmbeddingQuery(
      "我来帮你看看。\n```python\nprint('secret code')\n```\n\\[x^2 + y^2\\]",
      "请解释 $a^2+b^2=c^2$，谢谢！",
    )).toBe("我来帮你看看。\n请解释 ，谢谢！");
  });
});
