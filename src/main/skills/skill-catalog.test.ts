import { describe, it, expect } from "vitest";
import { buildAutoInjectedSkillContext, buildAutoInjectedSoulContext, buildSkillCatalog } from "./skill-catalog";
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
    expect(out).toContain("Skill 选择");
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

  it("distinguishes auto-injected skills from skills that require invoke_skill", () => {
    const music = e("cyrene-music-companion", "音乐陪伴");
    music.manifest = {
      id: music.id,
      version: "1.0.0",
      defaultEnabled: true,
      entry: "index.ts",
      dependencies: [],
      autoInject: true,
    };

    const out = buildSkillCatalog([music]);

    expect(out).toContain("自动注入");
    expect(out).toContain("无需再次调用 invoke_skill");
  });
});

describe("buildAutoInjectedSkillContext", () => {
  it("injects the full body only for enabled autoInject skills", () => {
    const music = e("cyrene-music-companion", "音乐陪伴");
    music.manifest = {
      id: music.id,
      version: "1.0.0",
      defaultEnabled: true,
      entry: "index.ts",
      dependencies: [],
      autoInject: true,
    };
    const ordinary = e("ordinary", "普通 Skill");

    const out = buildAutoInjectedSkillContext([music, ordinary], (id) =>
      id === music.id ? "只使用真实音乐工具结果。" : "不应注入",
    );

    expect(out).toContain("cyrene-music-companion");
    expect(out).toContain("只使用真实音乐工具结果。");
    expect(out).not.toContain("不应注入");
  });

  it("does not inject a disabled autoInject skill", () => {
    const music = e("cyrene-music-companion", "音乐陪伴", undefined, false);
    music.manifest = {
      id: music.id,
      version: "1.0.0",
      defaultEnabled: true,
      entry: "index.ts",
      dependencies: [],
      autoInject: true,
    };

    expect(buildAutoInjectedSkillContext([music], () => "正文")).toBe("");
  });
});

describe("buildAutoInjectedSoulContext", () => {
  it("injects only the Soul reply section and excludes tool instructions", () => {
    const music = e("cyrene-music-companion", "音乐陪伴");
    music.manifest = {
      id: music.id,
      version: "1.0.0",
      defaultEnabled: true,
      entry: "index.ts",
      dependencies: [],
      autoInject: true,
    };
    const body = [
      "# 音乐陪伴",
      "## Soul 回复策略",
      "用户无聊时可以自然提议听歌。",
      "## 工具调用策略",
      "调用 music_get_daily_recommendations。",
    ].join("\n");

    const out = buildAutoInjectedSoulContext([music], () => body);

    expect(out).toContain("用户无聊时可以自然提议听歌")
    expect(out).not.toContain("music_get_daily_recommendations")
  });

  it("reads a Soul reply section that ends at end-of-file", () => {
    const music = e("cyrene-music-companion", "音乐陪伴");
    music.manifest = {
      id: music.id,
      version: "1.0.0",
      defaultEnabled: true,
      entry: "index.ts",
      dependencies: [],
      autoInject: true,
    };

    const out = buildAutoInjectedSoulContext(
      [music],
      () => "# 音乐陪伴\n## Soul 回复策略\n用户无聊时可以提议听歌。",
    );

    expect(out).toContain("用户无聊时可以提议听歌")
  });
});
