import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseSkillFrontmatter, scanSkills } from "./skill-scanner";

describe("parseSkillFrontmatter", () => {
  it("解析合规 SKILL.md", () => {
    const md = `---
name: write-expense-report
description: 生成支出报告
tools: [query_expense, write_excel]
version: 1.0.0
---

# 写支出报告

调用 query_expense 取数据。`;
    const r = parseSkillFrontmatter(md);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("write-expense-report");
    expect(r!.description).toBe("生成支出报告");
    expect(r!.tools).toEqual(["query_expense", "write_excel"]);
    expect(r!.version).toBe("1.0.0");
    expect(r!.body).toContain("# 写支出报告");
    expect(r!.body).not.toContain("description:");
  });

  it("无 tools/version 也能解析", () => {
    const md = `---
name: plain
description: 纯指令
---
正文`;
    const r = parseSkillFrontmatter(md);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("plain");
    expect(r!.description).toBe("纯指令");
    expect(r!.tools).toBeUndefined();
    expect(r!.version).toBeUndefined();
    expect(r!.body).toBe("正文");
  });

  it("缺 name 返回 null", () => {
    const md = `---
description: 没 name
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

  it("无 frontmatter 返回 null", () => {
    expect(parseSkillFrontmatter("纯正文无 frontmatter")).toBeNull();
  });

  it("解析 modes 字段", () => {
    const md = `---
name: code-only
description: 仅 code 模式
tools: [query_expense]
modes: [code]
---
正文`;
    const r = parseSkillFrontmatter(md);
    expect(r).not.toBeNull();
    expect(r!.modes).toEqual(["code"]);
  });

  it("非法 modes 值被忽略", () => {
    const md = `---
name: x
description: d
modes: [invalid, CODE, learn]
---
正文`;
    const r = parseSkillFrontmatter(md);
    expect(r).not.toBeNull();
    expect(r!.modes).toEqual(["code", "learn"]);
  });
});

/** 建临时 skill 目录。 */
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

  it("扫描合规 skill，列出 references 文件名", () => {
    makeSkillDir(tmp, "write-expense-report",
      "---\nname: write-expense-report\ndescription: 生成支出报告\ntools: [query_expense]\n---\n正文",
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

  it("跳过不合规 skill（无 description）", () => {
    makeSkillDir(tmp, "bad", "---\nname: bad\n---\n正文");
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(0);
  });

  it("跳过没有 SKILL.md 的目录", () => {
    fs.mkdirSync(path.join(tmp, "empty"), { recursive: true });
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(0);
  });

  it("name 不等于目录名仍收录，id 用目录名", () => {
    makeSkillDir(tmp, "real-id", "---\nname: other-name\ndescription: x\n---\n正文");
    const r = scanSkills(tmp, "builtin");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("real-id");
    expect(r[0].name).toBe("other-name");
    expect(r[0].dirPath).toBe(path.join(tmp, "real-id"));
    expect(r[0].bodyPath).toBe(path.join(tmp, "real-id", "SKILL.md"));
  });

  it("目录不存在返回空数组", () => {
    const r = scanSkills(path.join(tmp, "nope"), "builtin");
    expect(r).toHaveLength(0);
  });

  it("空根目录返回空数组", () => {
    const emptyRoot = path.join(tmp, "empty-root");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const r = scanSkills(emptyRoot, "builtin");
    expect(r).toHaveLength(0);
  });

  it("无 references 目录时 references 为空数组", () => {
    makeSkillDir(tmp, "no-refs", "---\nname: no-refs\ndescription: x\n---\n正文");
    const r = scanSkills(tmp, "builtin");
    expect(r[0].references).toEqual([]);
  });

  it("references 下子目录被排除，只列文件", () => {
    makeSkillDir(tmp, "with-refs", "---\nname: with-refs\ndescription: x\n---\n正文");
    const refDir = path.join(tmp, "with-refs", "references");
    fs.mkdirSync(path.join(refDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(refDir, "note.md"), "n", "utf8");
    fs.writeFileSync(path.join(refDir, "sub", "inner.md"), "i", "utf8");
    const r = scanSkills(tmp, "builtin");
    expect(r[0].references).toEqual(["note.md"]);
  });

  it("多个 skill 都扫到，source 标记正确", () => {
    makeSkillDir(tmp, "a", "---\nname: a\ndescription: x\n---\n正文");
    makeSkillDir(tmp, "b", "---\nname: b\ndescription: y\n---\n正文");
    const r = scanSkills(tmp, "user");
    expect(r.map(s => s.id).sort()).toEqual(["a", "b"]);
    expect(r.every(s => s.source === "user")).toBe(true);
  });

  it("reads compound Skill dependencies and default switch from manifest.json", () => {
    makeSkillDir(tmp, "music", "---\nname: music\ndescription: d\n---\n正文");
    fs.writeFileSync(path.join(tmp, "music", "manifest.json"), JSON.stringify({
      id: "music",
      version: "1.0.0",
      defaultEnabled: false,
      entry: "index.ts",
      dependencies: ["music_search", "music_play_track"],
      autoPlayPolicy: "explicit_selection_or_delegate",
      autoInject: true,
    }), "utf8");

    const [skill] = scanSkills(tmp, "builtin");

    expect(skill.enabled).toBe(false);
    expect(skill.manifest?.dependencies).toEqual(["music_search", "music_play_track"]);
    expect(skill.manifest?.entry).toBe("index.ts");
    expect(skill.manifest?.autoInject).toBe(true);
  });
});
