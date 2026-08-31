import { describe, expect, it } from "vitest";
import { buildWriteCandidate, formatMemoryOverview, toolRegistry } from "./tool-registry";

describe("read_memory / write_memory 工具注册", () => {
  it("两个工具已注册且元数据正确", () => {
    const read = toolRegistry.getById("read_memory");
    expect(read).toBeTruthy();
    expect(read!.effectKind).toBe("read");

    const write = toolRegistry.getById("write_memory");
    expect(write).toBeTruthy();
    expect(write!.effectKind).toBe("mutation");
    // 引导约束：明确"仅限用户主动要求"，防止普通对话误触
    expect(write!.description).toContain("仅限用户主动要求");
    expect(write!.description).toContain("不要主动调用");
  });
});

describe("formatMemoryOverview", () => {
  it("空记忆 → 三层都显示（空）", () => {
    const out = formatMemoryOverview({}, {}, []);
    expect(out).toContain("核心画像（L0）");
    expect(out).toContain("- （空）");
    expect(out).toContain("共 0 条");
  });

  it("L0/L1 有值时展示，L0 锁定时提示", () => {
    const out = formatMemoryOverview(
      { preferredName: "P宝", occupation: "", isPinned: true },
      { recentGoals: "学 Rust" },
      [],
    );
    expect(out).toContain("称呼: P宝");
    expect(out).not.toContain("职业:");
    expect(out).toContain("近期目标: 学 Rust");
    expect(out).toContain("画像已被用户锁定");
  });

  it("L2 目录按时间倒序、超长内容截断、展示总数", () => {
    const items = [
      { id: "l2_old", title: "旧条目", createdAt: 1000, status: "active" },
      { id: "l2_new", title: "新条目", createdAt: 2000, status: "active" },
    ];
    const out = formatMemoryOverview({}, {}, items);
    expect(out).toContain("共 2 条");
    expect(out.indexOf("l2_new")).toBeLessThan(out.indexOf("l2_old"));
  });
});

describe("buildWriteCandidate", () => {
  it("合法参数 → explicit / user_explicit 候选（走 writeMemory 全部既有校验）", () => {
    const c = buildWriteCandidate({
      layer: "l2", content: " 用户下周三体检 ", slug: " 体检安排 ",
      sourceQuote: "记住我下周三要体检", triggerText: "记住我下周三要体检",
    });
    expect(c).toMatchObject({
      layer: "L2",
      content: "用户下周三体检",
      slug: "体检安排",
      certainty: "explicit",
      attribution: "user_explicit",
      shouldWrite: true,
    });
  });

  it("L0/L1 不吞 slug/sourceQuote（writeMemory 约定只有 L2 消费）", () => {
    const c = buildWriteCandidate({
      layer: "L0", field: "occupation", content: "前端工程师",
      slug: "不该出现", sourceQuote: "不该出现", triggerText: "x",
    });
    expect(c?.slug).toBeUndefined();
    expect(c?.sourceQuote).toBeUndefined();
    expect(c?.field).toBe("occupation");
  });

  it("非法 layer / 空 content → null", () => {
    expect(buildWriteCandidate({ layer: "L9", content: "x", triggerText: "x" })).toBeNull();
    expect(buildWriteCandidate({ layer: "L2", content: "  ", triggerText: "x" })).toBeNull();
  });
});
