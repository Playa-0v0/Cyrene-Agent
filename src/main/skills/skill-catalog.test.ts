import { describe, it, expect } from "vitest";
import { buildSkillCatalog } from "./skill-catalog";
import type { SkillEntry } from "./types";

function e(id: string, desc: string, tools?: string[], enabled = true): SkillEntry {
  return {
    id, name: id, description: desc, tools,
    dirPath: "/x", bodyPath: "/x", references: [],
    enabled, source: "builtin",
  };
}

describe("buildSkillCatalog", () => {
  it("無 skill 返回空串", () => {
    expect(buildSkillCatalog([])).toBe("");
  });

  it("全部 disabled 返回空串", () => {
    expect(buildSkillCatalog([e("a", "x", undefined, false)])).toBe("");
  });

  it("含標題 + 每條 id: description + tools 標註", () => {
    const out = buildSkillCatalog([e("write-expense-report", "生成支出報告", ["query_expense", "write_excel"])]);
    expect(out).toContain("可用 Skill");
    expect(out).toContain("invoke_skill");
    expect(out).toContain("- write-expense-report: 生成支出報告");
    expect(out).toContain("[tools: query_expense, write_excel]");
  });

  it("無 tools 字段不輸出 tools 標註", () => {
    const out = buildSkillCatalog([e("plain", "純指令")]);
    expect(out).toContain("- plain: 純指令");
    expect(out).not.toContain("[tools:");
  });

  it("tools 空數組不輸出 tools 標註", () => {
    const out = buildSkillCatalog([e("a", "x", [])]);
    expect(out).toContain("- a: x");
    expect(out).not.toContain("[tools:");
  });

  it("disabled skill 不進清單", () => {
    const out = buildSkillCatalog([e("a", "x"), e("b", "y", undefined, false)]);
    expect(out).toContain("- a: x");
    expect(out).not.toContain("- b:");
  });
});
