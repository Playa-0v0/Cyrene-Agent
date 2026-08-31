import { describe, it, expect } from "vitest";
import { parseLrc, mergeTranslation } from "./lyrics-parser";

describe("parseLrc", () => {
  it("parses timestamps and text, sorting ascending", () => {
    const lrc = [
      "[00:17.82]故事的小黄花",
      "[00:12.00]晴天",
      "[00:15.30]从出生那年就飘着",
    ].join("\n");
    expect(parseLrc(lrc)).toEqual([
      { timeMs: 12_000, text: "晴天" },
      { timeMs: 15_300, text: "从出生那年就飘着" },
      { timeMs: 17_820, text: "故事的小黄花" },
    ]);
  });

  it("expands multiple timestamps per line", () => {
    const out = parseLrc("[00:10.00][01:05.50]副歌");
    expect(out).toEqual([
      { timeMs: 10_000, text: "副歌" },
      { timeMs: 65_500, text: "副歌" },
    ]);
  });

  it("supports mm:ss / mm:ss.c / mm:ss.cc / mm:ss.ccc variants", () => {
    const out = parseLrc(["[01:02]a", "[01:02.5]b", "[01:02.50]c", "[01:02.500]d"].join("\n"));
    expect(out.map((l) => l.timeMs)).toEqual([62_000, 62_500, 62_500, 62_500]);
  });

  it("skips metadata tags and untimestamped lines", () => {
    const out = parseLrc(["[ti:晴天]", "[ar:周杰伦]", "no timestamp here", "[00:01.00]ok"].join("\n"));
    expect(out).toEqual([{ timeMs: 1_000, text: "ok" }]);
  });

  it("applies the offset tag (positive = earlier)", () => {
    const out = parseLrc(["[offset:500]", "[00:10.00]a", "[00:00.20]b"].join("\n"));
    expect(out).toEqual([
      { timeMs: 0, text: "b" }, // 200 - 500 clamped to 0
      { timeMs: 9_500, text: "a" },
    ]);
  });

  it("handles CRLF and stray whitespace", () => {
    const out = parseLrc("[00:05.00]  hello  \r\n\r\n[00:06.00]world\r\n");
    expect(out).toEqual([
      { timeMs: 5_000, text: "hello" },
      { timeMs: 6_000, text: "world" },
    ]);
  });

  it("returns [] for empty / no-timestamp input", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("[ti:x]\nplain text only")).toEqual([]);
  });
});

describe("mergeTranslation", () => {
  const lines = [
    { timeMs: 10_000, text: "hello" },
    { timeMs: 15_000, text: "world" },
    { timeMs: 20_000, text: "孤独" },
  ];

  it("时间戳精确一致 → 逐行合并 translation", () => {
    const trans = ["[00:10.00]你好", "[00:15.00]世界", "[00:20.00]lonely"].join("\n");
    const out = mergeTranslation(lines, trans);
    expect(out).toEqual([
      { timeMs: 10_000, text: "hello", translation: "你好" },
      { timeMs: 15_000, text: "world", translation: "世界" },
      { timeMs: 20_000, text: "孤独", translation: "lonely" },
    ]);
  });

  it("翻译时间戳有小漂移（<800ms）→ 容差就近匹配", () => {
    const trans = ["[00:10.30]你好", "[00:14.80]世界"].join("\n");
    const out = mergeTranslation(lines, trans);
    expect(out[0].translation).toBe("你好");
    expect(out[1].translation).toBe("世界");
    expect(out[2].translation).toBeUndefined();
  });

  it("翻译为空 / 无对应行 → 原样返回（不修改入参）", () => {
    expect(mergeTranslation(lines, "")).toBe(lines);
    expect(mergeTranslation([], "[00:10.00]x")).toEqual([]);
    const out = mergeTranslation(lines, "[01:00.00]迟到的翻译");
    expect(out.every((l) => l.translation === undefined)).toBe(true);
    // 入参未被修改
    expect(lines[0]).toEqual({ timeMs: 10_000, text: "hello" });
  });
});
