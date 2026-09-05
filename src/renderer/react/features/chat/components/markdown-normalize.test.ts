import { describe, expect, it } from "vitest";
import { normalizeModelMarkdown } from "./markdown-normalize";

describe("normalizeModelMarkdown", () => {
  it("`##标题` 补空格变成合法标题", () => {
    expect(normalizeModelMarkdown("##第一节：JS 变量与数据类型")).toBe(
      "## 第一节：JS 变量与数据类型",
    );
  });

  it("7 个及以上 # 不是标题，原样保留", () => {
    const line = "#######这不是标题";
    expect(normalizeModelMarkdown(line)).toBe(line);
  });

  it("标题与正文粘连（含句号）拆成标题 + 正文段落", () => {
    const input = "### 1. 怎么声明一个变量JS 一共给了你三个关键字——var。**新代码只用后两个**：";
    const output = normalizeModelMarkdown(input);
    const lines = output.split("\n");
    expect(lines[0]).toBe("### 1. 怎么声明一个变量JS 一共给了你三个关键字——var");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("**新代码只用后两个**：");
  });

  it("句号在标题行末尾（后面没有正文）时不拆分", () => {
    const input = "### 2. JS 有哪些数据类型JS 里有 7 种「基本类型」。";
    expect(normalizeModelMarkdown(input)).toBe(input);
  });

  it("围栏粘在句子后面（带语言标注）拆成独立围栏行", () => {
    const input = "### 5. JS 是「弱类型」——会偷偷转换```js\nconst a = 1;\n```";
    const output = normalizeModelMarkdown(input);
    expect(output).toContain("会偷偷转换\n\n```js");
    expect(output).toContain("### 5. JS 是「弱类型」——会偷偷转换");
  });

  it("裸 ``` 粘在文字后面（无语言标注）保守不动", () => {
    const input = "关闭围栏用```就好";
    expect(normalizeModelMarkdown(input)).toBe(input);
  });

  it("代码块内容一字不动（含畸形片段）", () => {
    const input = "```text\n##这不是标题\n文字```js\n```";
    expect(normalizeModelMarkdown(input)).toBe(input);
  });

  it("正常 Markdown 完全不变", () => {
    const input = [
      "## 第一节",
      "",
      "正常段落，讲道理。",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "- 列表项",
    ].join("\n");
    expect(normalizeModelMarkdown(input)).toBe(input);
  });

  it("行内代码里的 # 内容不受影响（不在行首）", () => {
    const input = "这段话里 `#话题标签` 是行内代码。";
    expect(normalizeModelMarkdown(input)).toBe(input);
  });

  it("归一化幂等：再跑一遍结果不变", () => {
    const input = [
      "##第一节：JS 变量与数据类型",
      "",
      "### 1. 怎么声明一个变量JS 一共给了你三个关键字。**正文**：",
      "",
      "会偷偷转换```js",
      "const a = 1;",
      "```",
    ].join("\n");
    const once = normalizeModelMarkdown(input);
    expect(normalizeModelMarkdown(once)).toBe(once);
  });

  it("用户实测消息样例：三类损伤同时修复", () => {
    const input = [
      "笔记和大纲都写好啦，现在开始讲 ♪",
      "",
      "##第一节：JS 变量与数据类型",
      "",
      "### 1. 怎么声明一个变量JS 一共给了你三个关键字——var。**新代码只用后两个**：",
      "",
      "```js",
      "const name = \"Hayes\";",
      "```",
      "",
      "### 5. JS 是「弱类型」——会偷偷转换```js",
      "\"5\" + 3",
      "```",
    ].join("\n");
    const output = normalizeModelMarkdown(input);
    expect(output).toContain("## 第一节：JS 变量与数据类型");
    expect(output).toContain("——var\n\n**新代码只用后两个**：");
    expect(output).toContain("——会偷偷转换\n\n```js");
    expect(output).toContain("const name = \"Hayes\";");
  });
});