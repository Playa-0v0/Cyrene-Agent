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
  it("无 skill 返回空串", () => {
    expect(buildSkillCatalog([])).toBe("");
  });

  it("全部 disabled 返回空串", () => {
    expect(buildSkillCatalog([e("a", "x", undefined, false)])).toBe("");
  });

  it("含标题 + 每条 id: description + tools 标注", () => {
    const out = buildSkillCatalog([e("write-expense-report", "生成支出报告", ["query_expense", "write_excel"])]);
    expect(out).toContain("可用 Skill");
    expect(out).toContain("invoke_skill");
    expect(out).toContain("- write-expense-report: 生成支出报告");
    expect(out).toContain("[tools: query_expense, write_excel]");
  });

  it("无 tools 字段不输出 tools 标注", () => {
    const out = buildSkillCatalog([e("plain", "纯指令")]);
    expect(out).toContain("- plain: 纯指令");
    expect(out).not.toContain("[tools:");
  });

  it("tools 空数组不输出 tools 标注", () => {
    const out = buildSkillCatalog([e("a", "x", [])]);
    expect(out).toContain("- a: x");
    expect(out).not.toContain("[tools:");
  });

  it("disabled skill 不进清单", () => {
    const out = buildSkillCatalog([e("a", "x"), e("b", "y", undefined, false)]);
    expect(out).toContain("- a: x");
    expect(out).not.toContain("- b:");
  });
});
