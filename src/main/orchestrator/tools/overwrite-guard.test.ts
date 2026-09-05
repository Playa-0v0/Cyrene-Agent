/**
 * 覆写防护纯函数测试：
 * - 大文件（≥50 行）且新内容行数占比 <50% 才拦截
 * - 小文件合法缩水放行；CRLF 与 LF 行数口径一致
 * - 报错文案引导模型走合法路径（str_replace / 求助用户），不鼓励原样重试
 */

import { describe, expect, it } from "vitest";
import {
  checkOverwriteDrop,
  overwriteDropMessage,
  OVERWRITE_DROP_MIN_LINES,
  OVERWRITE_DROP_RATIO,
} from "./overwrite-guard";

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("checkOverwriteDrop 骤降判定", () => {
  it("大文件 + 骤降过半 → 拦截", () => {
    const decision = checkOverwriteDrop(lines(100), lines(20));
    expect(decision.blocked).toBe(true);
    expect(decision.oldLineCount).toBe(100);
    expect(decision.newLineCount).toBe(20);
    expect(decision.ratio).toBeCloseTo(0.2);
  });

  it("大文件 + 缩水但不过半 → 放行", () => {
    // 100 行 → 60 行（60%）：合法的整理/压缩
    expect(checkOverwriteDrop(lines(100), lines(60)).blocked).toBe(false);
    // 恰好 50% 也放行（阈值是 < RATIO 才拦）
    expect(checkOverwriteDrop(lines(100), lines(50)).blocked).toBe(false);
  });

  it("小文件缩水再狠也放行（合法缩水常见）", () => {
    // 10 行笔记整理成 1 行：不拦，diff 卡全量可见、恢复容易
    expect(checkOverwriteDrop(lines(10), "一句话").blocked).toBe(false);
    // 门槛以下一行也拦不住
    expect(checkOverwriteDrop(lines(OVERWRITE_DROP_MIN_LINES - 1), "x").blocked).toBe(false);
  });

  it("门槛行数恰好达标且骤降 → 拦截", () => {
    expect(checkOverwriteDrop(lines(OVERWRITE_DROP_MIN_LINES), "x").blocked).toBe(true);
  });

  it("原文件为空 → 放行（ratio 兜底为 1）", () => {
    const decision = checkOverwriteDrop("", "新内容");
    expect(decision.blocked).toBe(false);
    expect(decision.ratio).toBe(1);
  });

  it("CRLF 行数口径与 LF 一致", () => {
    const crlf = lines(60).replace(/\n/g, "\r\n");
    const decision = checkOverwriteDrop(crlf, lines(10));
    expect(decision.oldLineCount).toBe(60);
    expect(decision.blocked).toBe(true);
  });
});

describe("overwriteDropMessage 报错文案", () => {
  it("包含行数、百分比与合法出口指引", () => {
    const message = overwriteDropMessage(checkOverwriteDrop(lines(120), lines(30)));
    expect(message).toContain("120");
    expect(message).toContain("30");
    expect(message).toContain("25%");
    expect(message).toContain("str_replace");
    expect(message).toContain("用户");
  });
});

describe("阈值常量", () => {
  it("拍板值不被意外改动：≥50 行且 <50% 拒绝", () => {
    expect(OVERWRITE_DROP_MIN_LINES).toBe(50);
    expect(OVERWRITE_DROP_RATIO).toBe(0.5);
  });
});
