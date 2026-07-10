import { describe, expect, it } from "vitest";
import { buildTurnModelContext } from "../shared/chat-context";

describe("buildTurnModelContext", () => {
  it("合并文档和图片上下文，不让后处理结果覆盖前处理结果", () => {
    const context = buildTurnModelContext({
      fileHints: ["文档 report.md 已建立索引 3 段"],
      documentContextLines: [
        "用户发送了文档 report.md，但文档处理失败：embedding failed。\n请诚实说明暂时无法分析该文档，不要编造文档内容。",
      ],
      imageCaptionLines: ["- chart.png：一张销售趋势图"],
      directImageLines: ["- photo.png：图片已随本轮消息直接发送给主模型。"],
    });

    expect(context).toContain("文档 report.md 已建立索引 3 段");
    expect(context).toContain("用户发送了文档 report.md，但文档处理失败：embedding failed。");
    expect(context).toContain("- chart.png：一张销售趋势图");
    expect(context).toContain("- photo.png：图片已随本轮消息直接发送给主模型。");
  });

  it("没有任何上下文时返回 undefined", () => {
    expect(buildTurnModelContext({})).toBeUndefined();
  });
});
