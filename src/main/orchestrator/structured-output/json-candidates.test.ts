import { describe, expect, test } from "vitest";
import { extractJsonCandidates } from "./json-candidates";

describe("extractJsonCandidates", () => {
  test("extracts a direct top-level object", () => {
    expect(extractJsonCandidates('{"decision":"respond"}').map((item) => item.value))
      .toEqual([{ decision: "respond" }]);
  });

  test("extracts fenced and prose-surrounded objects", () => {
    const text = '解释\n```json\n{"decision":"respond"}\n```\n另一个 {"decision":"ask_user"}';
    expect(extractJsonCandidates(text).map((item) => item.value)).toEqual([
      { decision: "respond" },
      { decision: "ask_user" },
    ]);
  });

  test("handles nested braces, escaped quotes, backslashes, unicode, and braces in strings", () => {
    const value = {
      text: '中文 {not structural} and "quote" and C:\\temp',
      nested: { ok: true },
    };
    expect(extractJsonCandidates(`prefix ${JSON.stringify(value)} suffix`)[0]?.value).toEqual(value);
  });

  test("deduplicates the same object found by direct, fence, or scan methods", () => {
    expect(extractJsonCandidates('```json\n{"b":2,"a":1}\n```\n{"a":1,"b":2}')).toHaveLength(1);
  });

  test.each([
    ["[1,2,3]"],
    ['"scalar"'],
    ["42"],
    ["true"],
    ['{"unfinished":'],
    [""],
  ])("rejects non-object or incomplete input: %s", (input) => {
    expect(extractJsonCandidates(input)).toEqual([]);
  });
});

