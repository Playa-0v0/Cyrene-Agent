import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown-renderer";

describe("markdown renderer", () => {
  // ── 基础格式 ──
  it("renders bold", () => {
    const result = renderMarkdown("**hello**");
    expect(result).toContain("<strong>hello</strong>");
  });

  it("renders italic", () => {
    const result = renderMarkdown("*world*");
    expect(result).toContain("<em>world</em>");
  });

  it("renders inline code", () => {
    const result = renderMarkdown("use `console.log()`");
    expect(result).toContain("<code>console.log()</code>");
  });

  it("renders bold and italic combined", () => {
    const result = renderMarkdown("**bold** and *italic* text");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
  });

  // ── 代码块 ──
  it("renders fenced code blocks", () => {
    const result = renderMarkdown("```\nconst x = 1;\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("<code>");
    expect(result).toContain("const x = 1;");
  });

  it("renders code blocks with language tag", () => {
    const result = renderMarkdown('```typescript\nconst x: number = 1;\n```');
    expect(result).toContain('<code class="language-typescript">');
  });

  // ── 标题 ──
  it("renders headings", () => {
    expect(renderMarkdown("# H1")).toContain("<h1");
    expect(renderMarkdown("## H2")).toContain("<h2");
    expect(renderMarkdown("### H3")).toContain("<h3");
  });

  // ── 列表 ──
  it("renders unordered lists", () => {
    const result = renderMarkdown("- item1\n- item2");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item1</li>");
    expect(result).toContain("<li>item2</li>");
  });

  it("renders ordered lists", () => {
    const result = renderMarkdown("1. first\n2. second");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>first</li>");
    expect(result).toContain("<li>second</li>");
  });

  // ── 引用 ──
  it("renders blockquotes", () => {
    const result = renderMarkdown("> quoted text");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quoted text");
  });

  // ── 链接 ──
  it("renders links", () => {
    const result = renderMarkdown("[click](https://example.com)");
    expect(result).toContain('<a href="https://example.com">');
    expect(result).toContain("click");
  });

  // ── 删除线 ──
  it("renders strikethrough (GFM)", () => {
    const result = renderMarkdown("~~deleted~~");
    expect(result).toContain("<del>deleted</del>");
  });

  // ── 表格 ──
  it("renders tables", () => {
    const result = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(result).toContain("<table>");
    expect(result).toContain("<th>A</th>");
    expect(result).toContain("<td>1</td>");
  });

  // ── 水平线 ──
  it("renders horizontal rules", () => {
    const result = renderMarkdown("---");
    expect(result).toContain("<hr");
  });

  // ── XSS 防护 ──
  it("strips <script> tags from output", () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toMatch(/<\s*script/i);
  });

  it("strips javascript: URLs", () => {
    const result = renderMarkdown('[evil](javascript:alert(1))');
    expect(result).not.toContain("javascript:");
  });

  it("strips on* event handlers", () => {
    // marked passes through raw HTML, our post-process strips onerror
    const result = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(result).not.toMatch(/\sonerror\s*=/i);
  });

  it("strips <iframe> tags", () => {
    const result = renderMarkdown('<iframe src="https://evil.com"></iframe>');
    expect(result).not.toMatch(/<\s*iframe/i);
  });

  // ── 边界情况 ──
  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("handles text with no markdown syntax", () => {
    const result = renderMarkdown("plain text");
    expect(result).toContain("plain text");
  });

  it("handles Chinese text with markdown", () => {
    const result = renderMarkdown("**加粗**文字和`代码`混合");
    expect(result).toContain("<strong>加粗</strong>");
    expect(result).toContain("<code>代码</code>");
  });

  it("treats single newlines as spaces (standard markdown)", () => {
    // breaks 关闭后，单 \n 等同于空格，只有双 \n 才分段
    const result = renderMarkdown("line1\nline2");
    expect(result).not.toContain("<br>");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });
});
