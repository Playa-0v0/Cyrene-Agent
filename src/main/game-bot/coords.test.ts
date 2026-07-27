// coords 單測 —— VLM 文本 → 座標/布爾/匹配索引 解析。
import { describe, it, expect } from "vitest";
import { parseClickCoord, parseBoolAnswer, parseMatchIndex } from "./coords";

describe("parseClickCoord", () => {
  it("解析 {x,y} 0-1000 歸一化 → 像素", () => {
    expect(parseClickCoord('{"x":500,"y":250}', 1920, 1080)).toEqual({ x: 960, y: 270 });
  });
  it("帶 ```json 圍欄", () => {
    expect(parseClickCoord('```json\n{"x":100,"y":100}\n```', 1000, 1000)).toEqual({ x: 100, y: 100 });
  });
  it("文本里夾 JSON", () => {
    expect(parseClickCoord('目標在 {"x":800,"y":600} 位置', 1000, 1000)).toEqual({ x: 800, y: 600 });
  });
  it("越界 clamp 到屏幕內", () => {
    expect(parseClickCoord('{"x":1500,"y":-100}', 1000, 1000)).toEqual({ x: 1000, y: 0 });
  });
  it("無 JSON 返回 null", () => {
    expect(parseClickCoord("沒找到目標", 1000, 1000)).toBeNull();
  });
  it("JSON 缺 x/y 返回 null", () => {
    expect(parseClickCoord('{"x":500}', 1000, 1000)).toBeNull();
  });
});

describe("parseBoolAnswer", () => {
  it('{"answer":true} → true', () => {
    expect(parseBoolAnswer('{"answer":true}')).toBe(true);
  });
  it('{"answer":false} → false', () => {
    expect(parseBoolAnswer('{"answer":false}')).toBe(false);
  });
  it("文字 是/有 → true", () => {
    expect(parseBoolAnswer("是的，有更新彈窗")).toBe(true);
  });
  it("文字 沒/無 → false", () => {
    expect(parseBoolAnswer("沒有，無彈窗")).toBe(false);
  });
  it("無法判斷 → null", () => {
    expect(parseBoolAnswer("也許吧")).toBeNull();
  });
});

describe("parseMatchIndex", () => {
  it('{"match":1} → 1', () => {
    expect(parseMatchIndex('{"match":1}', 2)).toBe(1);
  });
  it("索引越界 → null", () => {
    expect(parseMatchIndex('{"match":5}', 2)).toBeNull();
  });
  it("無 match 字段 → null", () => {
    expect(parseMatchIndex("不確定匹配哪個", 2)).toBeNull();
  });
});
