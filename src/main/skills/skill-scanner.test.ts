import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseSkillFrontmatter, scanSkills } from "./skill-scanner";

describe("parseSkillFrontmatter", () => {
  it("解析合規 SKILL.md", () => {
    const md = `---
name: write-expense-report
description: 生成支出報告
tools: [query_expense, write_excel]
version: 1.0.0
---

# 寫支出報告

調用 query_expense 取數據。`;
    const r = parseSkillFrontmatter(md);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("write-expense-report");
    expect(r!.description).toBe("生成支出報告");
    expect(r!.tools).toEqual(["query_expense", "write_excel"]);
    expect(r!.version).toBe("1.0.0");
    expect(r!.body).toContain("# 寫支出報告");
    expect(r!.body).not.toContain("description:");
  });

  it("無 tools/version 也能解析", () => {
    const md = `---
name: plain
description: 純指令
---
正文`;
    const r = parseSkillFrontmatter(md);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("plain");
    expect(r!.description).toBe("純指令");
    expect(r!.tools).toBeUndefined();
    expect(r!.version).toBeUndefined();
    expect(r!.body).toBe("正文");
  });

  it("缺 name 返回 null", () => {
    const md = `---
description: 沒 name
---
正文`;
    expect(parseSkillFrontmatter(md)).toBeNull();
  });

  it("缺 description 返回 null", () => {
    const md = `---
name: x
---
正文`;
    expect(parseSkillFrontmatter(md)).toBeNull();
  });

  it("tools 非 array 返回 null", () => {
    const md = `---
name: x
description: d
tools: query_expense
---
正文`;
    expect(parseSkillFrontmatter(md)).toBeNull();
  });

  it("無 frontmatter 返回 null", () => {
    expect(parseSkillFrontmatter("純正文無 frontmatter")).toBeNull();
  });
});

/** 建臨時 skill 目錄。 */
function makeSkillDir(root: string, id: string, md: string, refs: string[] = []): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), md, "utf8");
  if (refs.length > 0) {
    const rdir = path.join(dir, "references");
    fs.mkdirSync(rdir, { recursive: true });
    for (const r of refs) fs.writeFileSync(path.join(rdir, r), "ref content", "utf8");
  }
}

describe("scanSkills", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("掃描合規 skill，列出 references 文件名", () => {
    makeSkillDir(tmp, "write-expense-report",
      "---\nname: write-expense-report\ndescription: 生成支出報告\ntools: [query_expense]\n---\n正文",
      ["col-spec.md", "examples.json"]);
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("write-expense-report");
    expect(r[0].references).toEqual(expect.arrayContaining(["col-spec.md", "examples.json"]));
    expect(r[0].references).not.toContain("SKILL.md");
    expect(r[0].source).toBe("builtin");
    expect(r[0].enabled).toBe(true);
    expect(r[0].dirPath).toBe(path.join(tmp, "write-expense-report"));
  });

  it("跳過不合規 skill（無 description）", () => {
    makeSkillDir(tmp, "bad", "---\nname: bad\n---\n正文");
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(0);
  });

  it("跳過沒有 SKILL.md 的目錄", () => {
    fs.mkdirSync(path.join(tmp, "empty"), { recursive: true });
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(0);
  });

  it("name 不等於目錄名仍收錄，id 用目錄名", () => {
    makeSkillDir(tmp, "real-id", "---\nname: other-name\ndescription: x\n---\n正文");
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("real-id");
    expect(r[0].name).toBe("other-name");
    expect(r[0].dirPath).toBe(path.join(tmp, "real-id"));
    expect(r[0].bodyPath).toBe(path.join(tmp, "real-id", "SKILL.md"));
  });

  it("目錄不存在返回空數組", () => {
    const r = scanSkills(path.join(tmp, "nope"), "builtin");
    expect(r).toHaveLength(0);
  });

  it("空根目錄返回空數組", () => {
    const emptyRoot = path.join(tmp, "empty-root");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const r = scanSkills(emptyRoot, "builtin");
    expect(r).toHaveLength(0);
  });

  it("無 references 目錄時 references 為空數組", () => {
    makeSkillDir(tmp, "no-refs", "---\nname: no-refs\ndescription: x\n---\n正文");
    const r = scanSkills(tmp, "builtin");
    expect(r[0].references).toEqual([]);
  });

  it("references 下子目錄被排除，只列文件", () => {
    makeSkillDir(tmp, "with-refs", "---\nname: with-refs\ndescription: x\n---\n正文");
    const refDir = path.join(tmp, "with-refs", "references");
    fs.mkdirSync(path.join(refDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(refDir, "note.md"), "n", "utf8");
    fs.writeFileSync(path.join(refDir, "sub", "inner.md"), "i", "utf8");
    const r = scanSkills(tmp, "builtin");
    expect(r[0].references).toEqual(["note.md"]);
  });

  it("多個 skill 都掃到，source 標記正確", () => {
    makeSkillDir(tmp, "a", "---\nname: a\ndescription: x\n---\n正文");
    makeSkillDir(tmp, "b", "---\nname: b\ndescription: y\n---\n正文");
    const r = scanSkills(tmp, "user");
    expect(r.map(s => s.id).sort()).toEqual(["a", "b"]);
    expect(r.every(s => s.source === "user")).toBe(true);
  });
});
