// tool-evidence 单测 — diff 行构建 / 截断上限 / changes 提取校验。

import { describe, expect, it } from "vitest";

import {
  buildFullFileDiff,
  buildReplacedDiff,
  countLines,
  extractFileChangesFromOutput,
  finalizeFileChanges,
  parseUnifiedPatch,
} from "./tool-evidence";

describe("buildReplacedDiff / buildFullFileDiff", () => {
  it("orders context/remove/add lines around the replacement", () => {
    const lines = buildReplacedDiff(["old1", "old2"], ["new1"], ["ctx-before"], ["ctx-after"]);
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "context:ctx-before",
      "remove:old1",
      "remove:old2",
      "add:new1",
      "context:ctx-after",
    ]);
  });

  it("marks every line of a full-file diff with the given mode", () => {
    expect(buildFullFileDiff(["a", "b"], "add").every((l) => l.type === "add")).toBe(true);
    expect(buildFullFileDiff(["a"], "remove")[0].type).toBe("remove");
  });

  it("clips overly long lines", () => {
    const [line] = buildFullFileDiff(["x".repeat(300)], "add");
    expect(line.text.length).toBeLessThanOrEqual(201); // 200 字符 + 省略号
    expect(line.text.endsWith("…")).toBe(true);
  });
});

describe("parseUnifiedPatch", () => {
  it("classifies hunk headers, additions, removals, context and skips file headers", () => {
    const lines = parseUnifiedPatch([
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
    ].join("\n"));
    expect(lines.map((l) => l.type)).toEqual(["hunk", "context", "remove", "add"]);
    expect(lines[2].text).toBe("old");
  });
});

describe("finalizeFileChanges", () => {
  it("keeps small diffs intact", () => {
    const changes = finalizeFileChanges([{
      file: "a.ts", kind: "modified", insertions: 1, deletions: 1,
      diff: [{ type: "add", text: "x" }],
    }]);
    expect(changes[0].truncated).toBeUndefined();
  });

  it("truncates diff but keeps statistics when per-file budget is exceeded", () => {
    const bigDiff = Array.from({ length: 100 }, (_, i) => ({ type: "add" as const, text: `line-${i}` }));
    const changes = finalizeFileChanges([{
      file: "a.ts", kind: "added", insertions: 100, deletions: 0, diff: bigDiff,
    }]);
    expect(changes[0].diff).toHaveLength(60);
    expect(changes[0].truncated).toBe(true);
    expect(changes[0].insertions).toBe(100); // 统计数字保留
  });

  it("drops diff of later files once the total budget is spent", () => {
    const bigDiff = Array.from({ length: 60 }, (_, i) => ({ type: "add" as const, text: `l${i}` }));
    const changes = finalizeFileChanges([
      { file: "a.ts", kind: "added", insertions: 60, deletions: 0, diff: bigDiff },
      { file: "b.ts", kind: "added", insertions: 60, deletions: 0, diff: bigDiff },
      { file: "c.ts", kind: "added", insertions: 60, deletions: 0, diff: bigDiff },
      { file: "d.ts", kind: "added", insertions: 60, deletions: 0, diff: bigDiff },
    ]);
    // 60+60+60=180 < 200：前三个完整保留
    expect(changes[0].diff).toHaveLength(60);
    expect(changes[1].diff).toHaveLength(60);
    expect(changes[2].diff).toHaveLength(60);
    // 第四个只剩 20 行预算：截断到 20 并标记
    expect(changes[3].diff).toHaveLength(20);
    expect(changes[3].truncated).toBe(true);
    expect(changes[3].insertions).toBe(60);
  });
});

describe("extractFileChangesFromOutput", () => {
  it("extracts a valid changes array from a full tool output JSON", () => {
    const output = JSON.stringify({
      tool: "str_replace",
      success: true,
      changes: [{ file: "src/a.ts", kind: "modified", insertions: 2, deletions: 1 }],
    });
    expect(extractFileChangesFromOutput(output)).toEqual([
      { file: "src/a.ts", kind: "modified", insertions: 2, deletions: 1 },
    ]);
  });

  it("returns undefined for non-JSON, empty, or change-less outputs", () => {
    expect(extractFileChangesFromOutput(undefined)).toBeUndefined();
    expect(extractFileChangesFromOutput("plain text")).toBeUndefined();
    expect(extractFileChangesFromOutput(JSON.stringify({ success: true }))).toBeUndefined();
    expect(extractFileChangesFromOutput(JSON.stringify({ changes: [] }))).toBeUndefined();
  });

  it("returns undefined when any entry is malformed", () => {
    expect(extractFileChangesFromOutput(JSON.stringify({ changes: [{ file: "a.ts" }] }))).toBeUndefined();
    expect(
      extractFileChangesFromOutput(
        JSON.stringify({ changes: [{ file: "a.ts", kind: "weird", insertions: 1, deletions: 0 }] }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a truncated JSON string (preview cut)", () => {
    const output = JSON.stringify({
      tool: "str_replace",
      changes: [{ file: "a.ts", kind: "modified", insertions: 2, deletions: 1 }],
    }).slice(0, 30);
    expect(extractFileChangesFromOutput(output)).toBeUndefined();
  });
});

describe("countLines", () => {
  it("does not count a trailing empty line", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("")).toBe(0);
  });
});
