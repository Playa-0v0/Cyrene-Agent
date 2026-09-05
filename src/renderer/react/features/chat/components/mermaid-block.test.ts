// @vitest-environment jsdom
/**
 * Mermaid 渲染管线端到端测试：源码 → 引擎 → 剥外呼 → 消毒，验证每条降级路径。
 */

import { describe, expect, it } from "vitest";
import { renderMermaidSafe } from "./MermaidBlock";

describe("renderMermaidSafe", () => {
  it("流程图正常渲染：出 SVG、无字体外呼、无脚本", () => {
    const out = renderMermaidSafe(["graph TD", "A[开始] --> B{判断}", "B -->|是| C[执行]", "B -->|否| D[结束]"].join("\n"));
    expect(out.kind).toBe("svg");
    if (out.kind !== "svg") return;
    expect(out.svg).toContain("<svg");
    expect(out.svg).toContain("开始");
    expect(out.svg).not.toContain("fonts.googleapis.com");
    expect(out.svg).not.toMatch(/<script/i);
  });

  it("五类支持图型都能出图", () => {
    const cases = [
      ["graph TD", "A --> B"].join("\n"),
      ["sequenceDiagram", "Alice->>Bob: Hi", "Bob-->>Alice: Hello"].join("\n"),
      ["stateDiagram-v2", "s1 --> s2"].join("\n"),
      ["classDiagram", "Animal <|-- Dog"].join("\n"),
      ["erDiagram", "USER ||--o{ POST : has"].join("\n"),
    ];
    for (const code of cases) {
      expect(renderMermaidSafe(code).kind).toBe("svg");
    }
  });

  it("引擎不支持的图型（mindmap）降级为 error", () => {
    const out = renderMermaidSafe(["mindmap", "root((a))"].join("\n"));
    expect(out.kind).toBe("error");
  });

  it("乱码语法降级为 error 而不是抛异常", () => {
    const out = renderMermaidSafe("这不是一段 mermaid");
    expect(out.kind).toBe("error");
  });

  it("超长源码直接熔断降级，不进同步渲染", () => {
    const lines = ["graph TD"];
    for (let i = 0; i < 2000; i++) lines.push(`N${i}[label${i}] --> N${i + 1}`);
    const out = renderMermaidSafe(lines.join("\n"));
    expect(out.kind).toBe("fuse");
  });
});
