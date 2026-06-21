import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillRegistry } from "./skill-registry";
import type { SkillEntry } from "./types";

function entry(id: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id,
    name: id,
    description: "d-" + id,
    dirPath: "/tmp/" + id,
    bodyPath: "/tmp/" + id + "/SKILL.md",
    references: [],
    enabled: true,
    source: "builtin",
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  let reg: SkillRegistry;
  beforeEach(() => { reg = new SkillRegistry(); });

  it("register / getById / getEnabled / getAll", () => {
    reg.register(entry("a"));
    reg.register(entry("b", { enabled: false }));
    expect(reg.getById("a")?.id).toBe("a");
    expect(reg.getEnabled().map(s => s.id)).toEqual(["a"]);
    expect(reg.getAll().map(s => s.id).sort()).toEqual(["a", "b"]);
  });

  it("setEnabled 切换", () => {
    reg.register(entry("a", { enabled: false }));
    reg.setEnabled("a", true);
    expect(reg.getById("a")?.enabled).toBe(true);
    expect(reg.getEnabled().map(s => s.id)).toEqual(["a"]);
  });

  it("getBody 懒加载 + 缓存（改磁盘不刷新）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
    const mdPath = path.join(tmp, "SKILL.md");
    fs.writeFileSync(mdPath, "---\nname: a\ndescription: d\n---\n正文v1", "utf8");
    reg.register(entry("a", { bodyPath: mdPath }));
    expect(reg.getBody("a")).toBe("正文v1");
    // 改磁盘，缓存应返回旧内容（懒加载缓存语义，见 spec 5.4）
    fs.writeFileSync(mdPath, "---\nname: a\ndescription: d\n---\n正文v2", "utf8");
    expect(reg.getBody("a")).toBe("正文v1");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("getBody 不存在返回 null", () => {
    expect(reg.getBody("nope")).toBeNull();
  });

  it("getBody 去掉 frontmatter 只返回正文", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
    const mdPath = path.join(tmp, "SKILL.md");
    fs.writeFileSync(mdPath, "---\nname: a\ndescription: d\ntools: [x]\n---\n# 正文\n调用工具", "utf8");
    reg.register(entry("a", { bodyPath: mdPath }));
    const body = reg.getBody("a");
    expect(body).toBe("# 正文\n调用工具");
    expect(body).not.toContain("description");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("getReference 命中清单才读", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
    const refDir = path.join(tmp, "references");
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, "ok.md"), "ref", "utf8");
    reg.register(entry("a", { dirPath: tmp, references: ["ok.md"] }));
    expect(reg.getReference("a", "ok.md")).toBe("ref");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("getReference 拒绝不在清单的 ref（路径穿越防护）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
    reg.register(entry("a", { dirPath: tmp, references: ["ok.md"] }));
    expect(reg.getReference("a", "../../../etc/passwd")).toBeNull();
    expect(reg.getReference("a", "not-in-list.md")).toBeNull();
    expect(reg.getReference("a", "ok.md/../../etc")).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("getReference skill 不存在返回 null", () => {
    expect(reg.getReference("nope", "x.md")).toBeNull();
  });

  it("getBody bodyPath 不存在返回 null", () => {
    reg.register(entry("a", { bodyPath: "/nonexistent/path/SKILL.md" }));
    expect(reg.getBody("a")).toBeNull();
  });

  it("getReference 文件被删返回 null", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
    const refDir = path.join(tmp, "references");
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, "ok.md"), "ref", "utf8");
    reg.register(entry("a", { dirPath: tmp, references: ["ok.md"] }));
    fs.unlinkSync(path.join(refDir, "ok.md"));
    expect(reg.getReference("a", "ok.md")).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
