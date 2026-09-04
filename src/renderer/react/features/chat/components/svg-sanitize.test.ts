// @vitest-environment jsdom
/**
 * SVG 消毒安全层测试：模型输出是不可信输入，注入前必须剥掉全部逃逸向量。
 */

import { describe, expect, it } from "vitest";
import { isOverSourceLimit, sanitizeSvg, stripFontImports, SVG_SOURCE_LIMIT } from "./svg-sanitize";

describe("sanitizeSvg", () => {
  it("剥掉 <script> 注入", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("rect");
  });

  it("剥掉 onload 等事件属性", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(2)"><rect width="10" height="10" onclick="alert(3)"/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("剥掉 javascript: 协议链接", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(4)"><text>x</text></a></svg>';
    const out = sanitizeSvg(svg);
    expect(out).not.toMatch(/javascript\s*:/i);
  });

  it("剥掉 foreignObject 逃逸向量", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(5)</script></div></foreignObject></svg>';
    const out = sanitizeSvg(svg);
    expect(out.toLowerCase()).not.toContain("foreignobject");
  });

  it("保留正常图形内容与主题 CSS 变量", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" style="--bg:#fffafc"><style>.node { fill: var(--surface, #fdf0f3); }</style><g class="node"><rect width="10" height="10" data-id="A" data-label="开始"/><text>开始</text></g></svg>';
    const out = sanitizeSvg(svg);
    expect(out).toContain("rect");
    expect(out).toContain("开始");
    expect(out).toContain("data-id");
    expect(out).toContain("--bg");
  });
});

describe("stripFontImports", () => {
  it("剥掉 Google Fonts @import，保留其余样式", () => {
    const svg = [
      "<svg xmlns=\"http://www.w3.org/2000/svg\">",
      "<style>",
      "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap');",
      "@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&amp;display=swap');",
      "text { font-family: 'Inter', system-ui, sans-serif; }",
      "</style>",
      "<text>x</text>",
      "</svg>",
    ].join("\n");
    const out = stripFontImports(svg);
    expect(out).not.toContain("fonts.googleapis.com");
    expect(out).toContain("font-family");
    expect(out).toContain("<text>x</text>");
  });
});

describe("isOverSourceLimit", () => {
  it("阈值内放行，超限熔断", () => {
    expect(isOverSourceLimit("a".repeat(SVG_SOURCE_LIMIT))).toBe(false);
    expect(isOverSourceLimit("a".repeat(SVG_SOURCE_LIMIT + 1))).toBe(true);
  });
});
