/**
 * markdown-renderer 单元测试
 *
 * 测试环境为 Node（无 DOM），DOMPurify 需要 DOM 才能工作，
 * 因此 mock 为 identity（markdown-it html:false 已提供第一层 XSS 防护）。
 *
 * @mdit/plugin-katex 在 Node 环境依赖 katex 的 renderToString，
 * mock 为简单的 span 包裹以验证公式识别。
 *
 * code-highlighter 在测试环境（Shiki 未初始化）时会走 fallback 路径，
 * 返回 <pre class="shiki"><code>escaped</code></pre>。
 */

import { describe, expect, test, vi } from "vitest";

// mock DOMPurify（Node 环境无 DOM，identity 即可；markdown-it html:false 已转义）
vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

import { renderMarkdown } from "./markdown-renderer";

describe("renderMarkdown", () => {
  test("returns html mode for normal markdown", () => {
    const result = renderMarkdown("# Hello World");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<h1>");
    expect(result.content).toContain("Hello World");
  });

  test("renders unordered list", () => {
    const result = renderMarkdown("- item 1\n- item 2\n- item 3");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<ul>");
    expect(result.content).toContain("item 1");
    expect(result.content).toContain("item 3");
  });

  test("renders ordered list", () => {
    const result = renderMarkdown("1. first\n2. second");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<ol>");
    expect(result.content).toContain("first");
  });

  test("renders blockquote", () => {
    const result = renderMarkdown("> This is a quote");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<blockquote>");
    expect(result.content).toContain("This is a quote");
  });

  test("renders table", () => {
    const md = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
    const result = renderMarkdown(md);
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<table>");
    expect(result.content).toContain("Alice");
  });

  test("renders bold and italic", () => {
    const result = renderMarkdown("**bold** and *italic*");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<strong>bold</strong>");
    expect(result.content).toContain("<em>italic</em>");
  });

  test("renders strikethrough", () => {
    const result = renderMarkdown("~~deleted~~");
    expect(result.mode).toBe("html");
    // markdown-it uses <s> for strikethrough by default
    expect(result.content).toContain("<s>deleted</s>");
  });

  test("renders links with target=_blank for external URLs", () => {
    const result = renderMarkdown("[Google](https://google.com)");
    expect(result.mode).toBe("html");
    expect(result.content).toContain('href="https://google.com"');
    expect(result.content).toContain('target="_blank"');
    expect(result.content).toContain('rel="noopener noreferrer"');
  });

  test("renders internal links without target=_blank", () => {
    const result = renderMarkdown("[Section](#section)");
    expect(result.mode).toBe("html");
    expect(result.content).toContain('href="#section"');
    expect(result.content).not.toContain('target="_blank"');
  });

  test("renders fenced code block with .code-block wrapper", () => {
    const result = renderMarkdown("```typescript\nconst x = 1;\n```");
    expect(result.mode).toBe("html");
    expect(result.content).toContain('class="code-block"');
    expect(result.content).toContain('class="code-block__header"');
    expect(result.content).toContain('class="code-block__language"');
    expect(result.content).toContain("TypeScript");
    expect(result.content).toContain('class="code-block__copy"');
    expect(result.content).toContain('class="code-block__code"');
    // Shiki 未就绪时应该是 fallback <pre class="shiki">
    expect(result.content).toContain('class="shiki"');
    // 代码内容应该被转义
    expect(result.content).toContain("const x = 1;");
  });

  test("renders inline code", () => {
    const result = renderMarkdown("Use `npm install` to install");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<code>npm install</code>");
  });

  test("renders horizontal rule", () => {
    const result = renderMarkdown("---");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<hr");
  });

  test("handles empty string", () => {
    const result = renderMarkdown("");
    expect(result.mode).toBe("html");
    expect(result.content).toBe("");
  });

  test("handles whitespace-only string", () => {
    const result = renderMarkdown("   \n\n   ");
    expect(result.mode).toBe("html");
    expect(result.content).toBe("");
  });

  test("handles special characters safely", () => {
    const result = renderMarkdown("Use < and > and & safely");
    expect(result.mode).toBe("html");
    // markdown-it should escape these
    expect(result.content).toContain("&lt;");
    expect(result.content).toContain("&gt;");
    expect(result.content).toContain("&amp;");
  });
});

describe("renderMarkdown - XSS protection", () => {
  test("escapes <script> tags (not executable)", () => {
    // markdown-it html:false escapes raw HTML; DOMPurify (in production) strips entirely
    const result = renderMarkdown("<script>alert(1)</script>");
    expect(result.mode).toBe("html");
    // No executable <script> tag should be present
    expect(result.content).not.toContain("<script>");
    // Content should be escaped
    expect(result.content).toContain("&lt;script&gt;");
  });

  test("escapes <img onerror> attributes (not executable)", () => {
    const result = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(result.mode).toBe("html");
    // No executable <img> tag should be present
    expect(result.content).not.toContain("<img ");
    // Content should be escaped
    expect(result.content).toContain("&lt;img");
  });

  test("blocks javascript: protocol in links", () => {
    // markdown-it's default validateLink blocks javascript: URLs,
    // rendering them as literal text (not as an href attribute)
    const result = renderMarkdown('[click](javascript:alert(1))');
    expect(result.mode).toBe("html");
    // javascript: must never appear as an href attribute
    expect(result.content).not.toContain('href="javascript');
    expect(result.content).not.toContain("href='javascript");
  });

  test("blocks data: protocol in links", () => {
    // markdown-it may not parse this as a link due to special chars;
    // the key is that data: protocol never appears as an href
    const result = renderMarkdown('[click](data:text/html,xxx)');
    expect(result.mode).toBe("html");
    expect(result.content).not.toContain('href="data:');
  });

  test("code block content is escaped, not executable", () => {
    const code = '<script>alert("xss")</script>';
    const result = renderMarkdown("```html\n" + code + "\n```");
    expect(result.mode).toBe("html");
    // The raw <script> tag should not appear unescaped
    expect(result.content).not.toContain('<script>alert("xss")</script>');
    // Should be escaped inside the code block
    expect(result.content).toContain("&lt;script&gt;");
  });
});

describe("renderMarkdown - unknown/edge case languages", () => {
  test("unknown language falls back to text in code block", () => {
    const result = renderMarkdown("```rust\nfn main() {}\n```");
    expect(result.mode).toBe("html");
    expect(result.content).toContain('class="code-block"');
    // Should still show the code, just without specific highlighting
    expect(result.content).toContain("fn main()");
  });

  test("no language specified renders as text", () => {
    const result = renderMarkdown("```\nplain text code\n```");
    expect(result.mode).toBe("html");
    expect(result.content).toContain('class="code-block"');
    expect(result.content).toContain("plain text code");
  });

  test("alias ps1 is normalized to powershell display name", () => {
    const result = renderMarkdown("```ps1\nGet-Process\n```");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("PowerShell");
    expect(result.content).toContain("Get-Process");
  });

  test("alias cmd is normalized to CMD / Batch display name", () => {
    const result = renderMarkdown("```cmd\necho hello\n```");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("CMD / Batch");
    expect(result.content).toContain("echo hello");
  });
});

describe("renderMarkdown - KaTeX 数学公式", () => {
  test("行内公式 $E=mc^2$", () => {
    const result = renderMarkdown("能量公式 $E=mc^2$ 很有名");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("katex");
  });

  test("块级公式 $$...$$", () => {
    const result = renderMarkdown("$$\np_i = \\frac{e^{z_i}}{\\sum_j e^{z_j}}\n$$");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("katex-block");
  });

  test("多个行内公式", () => {
    const result = renderMarkdown("$a^2 + b^2 = c^2$ 和 $E=mc^2$ 都是公式");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("katex");
    // 应该有两个公式
    const matches = result.content.match(/class="katex"/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  test("普通美元符号不被误识别为公式", () => {
    const result = renderMarkdown("这个花了 $5 和 $10");
    expect(result.mode).toBe("html");
    // $5 和 $10 不应该被识别为公式
    expect(result.content).not.toContain('class="katex"');
    expect(result.content).toContain("$5");
    expect(result.content).toContain("$10");
  });

  test("单个 $ 不触发公式", () => {
    const result = renderMarkdown("价格是 $5");
    expect(result.mode).toBe("html");
    expect(result.content).not.toContain('class="katex"');
  });

  test("无效 LaTeX 不崩溃（throwOnError:false）", () => {
    const result = renderMarkdown("$\\invalidcommand{}$");
    expect(result.mode).toBe("html");
    // 无效 LaTeX 应该显示 katex-error 或原始内容，不崩溃
    expect(result.content).toContain("katex");
  });

  test("公式和 Markdown 混合", () => {
    const result = renderMarkdown("## 标题\n\n公式 $x^2$ 在这里\n\n```\ncode\n```");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("<h2>标题</h2>");
    expect(result.content).toContain("katex");
    expect(result.content).toContain("code-block");
  });

  test("块级公式前后有文本", () => {
    const result = renderMarkdown("前文\n\n$$\nx = y\n$$\n\n后文");
    expect(result.mode).toBe("html");
    expect(result.content).toContain("katex-block");
    expect(result.content).toContain("前文");
    expect(result.content).toContain("后文");
  });
});
