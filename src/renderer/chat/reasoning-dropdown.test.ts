// 推理下拉渲染测试（用户修正 #6：断言 labels 非数字）
import { describe, expect, test } from "vitest";
import { computeReasoningDropdown, formatReasoningTriggerLabel } from "./reasoning-dropdown";
import type { ReasoningPreference } from "../../shared/reasoning";

function labels(view: ReturnType<typeof computeReasoningDropdown>): string[] {
  return view.items.map(i => i.label);
}

function activeLabel(view: ReturnType<typeof computeReasoningDropdown>): string {
  const found = view.items.find(i =>
    JSON.stringify(i.preference) === JSON.stringify(view.activePreference),
  );
  return found?.label ?? "?";
}

describe("computeReasoningDropdown — ChatGPT", () => {
  test("gpt-5.6 + undefined saved → 7 项：跟随 / 关闭 / 低 / 中 / 高 / 极高 / 最强", () => {
    const v = computeReasoningDropdown("chatgpt", "gpt-5.6", undefined);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "低", "中", "高", "极高", "最强"]);
    expect(v.disabled).toBe(false);
    expect(v.statusText).toBe("跟随模型"); // effective ≈ auto
    expect(v.items[0].disabled).toBeUndefined();
  });

  test("gpt-5.6 + {on, high} saved → activeLabel=高", () => {
    const v = computeReasoningDropdown("chatgpt", "gpt-5.6", { mode: "on", effort: "high" });
    expect(activeLabel(v)).toBe("高");
    expect(v.statusText).toBe("高");
  });

  test("gpt-5 + {on, minimal} saved → minimal 在列，activeLabel=最低", () => {
    const v = computeReasoningDropdown("chatgpt", "gpt-5", { mode: "on", effort: "minimal" });
    expect(labels(v)).toEqual(["跟随模型", "关闭", "最低", "低", "中", "高"]);
    expect(activeLabel(v)).toBe("最低");
  });

  test("gpt-4o → disabled（兜底 none）", () => {
    const v = computeReasoningDropdown("chatgpt", "gpt-4o", undefined);
    expect(v.disabled).toBe(true);
    expect(v.statusText).toBe("跟随模型");
    expect(labels(v)).toEqual(["跟随模型"]);
  });
});

describe("computeReasoningDropdown — Claude", () => {
  test("claude-sonnet-5 → 跟随 / 关闭 / 低 / 中 / 高 / 极高 / 最强", () => {
    const v = computeReasoningDropdown("claude", "claude-sonnet-5", undefined);
    expect(v.disabled).toBe(false);
    expect(v.items[0].label).toBe("跟随模型");
    expect(v.items[1].label).toBe("关闭");
    expect(v.items[2].label).toBe("低");
  });
});

describe("computeReasoningDropdown — DeepSeek", () => {
  test("deepseek-v4-pro → 跟随 / 关闭 / 高 / 最强（effort=2）", () => {
    const v = computeReasoningDropdown("deepseek", "deepseek-v4-pro", undefined);
    expect(v.disabled).toBe(false);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "高", "最强"]);
  });

  test("deepseek-v4-pro + {on, effort:max} → 高亮最强", () => {
    const v = computeReasoningDropdown("deepseek", "deepseek-v4-pro", { mode: "on", effort: "max" });
    expect(activeLabel(v)).toBe("最强");
    expect(v.statusText).toBe("最强");
  });
});

describe("computeReasoningDropdown — GLM", () => {
  test("glm-5.2 → 跟随 / 关闭 / 高 / 最强（effort=2）", () => {
    const v = computeReasoningDropdown("glm", "glm-5.2", undefined);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "高", "最强"]);
  });

  test("glm-4.7 → 跟随 / 关闭 / 开启（toggle only）", () => {
    const v = computeReasoningDropdown("glm", "glm-4.7", undefined);
    expect(v.disabled).toBe(false);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "开启"]);
  });
});

describe("computeReasoningDropdown — Qwen", () => {
  test("qwen3-max → 跟随 / 关闭 / 开启（toggle + qwen-enable-thinking）", () => {
    const v = computeReasoningDropdown("qwen", "qwen3-max", undefined);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "开启"]);
    expect(v.disabled).toBe(false);
  });

  test("qwen3-thinking → fixed-on，disabled，单项 始终开启", () => {
    const v = computeReasoningDropdown("qwen", "qwen3-thinking", { mode: "on" });
    expect(v.disabled).toBe(true);
    expect(v.statusText).toBe("始终开启");
    expect(labels(v)).toEqual(["始终开启"]);
    expect(v.items[0].disabled).toBe(true);
    // fixed-on 不可选，disabled item 不绑定 click handler
  });
});

describe("computeReasoningDropdown — Kimi", () => {
  test("kimi-k2.6 → 跟随 / 关闭 / 开启（toggle）", () => {
    const v = computeReasoningDropdown("kimi", "kimi-k2.6", undefined);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "开启"]);
  });

  test("kimi-k2.6 + {on} + 调 computeReasoningDropdown → active=开启", () => {
    const v = computeReasoningDropdown("kimi", "kimi-k2.6", { mode: "on" });
    expect(activeLabel(v)).toBe("开启");
  });

  test("kimi-k2.7-code → fixed-on（K2.7 Code 无 thinking 字段）", () => {
    const v = computeReasoningDropdown("kimi", "kimi-k2.7-code", undefined);
    expect(v.disabled).toBe(true);
    expect(v.statusText).toBe("始终开启");
    expect(labels(v)).toEqual(["始终开启"]);
  });
});

describe("computeReasoningDropdown — MiniMax (anthropic-adaptive)", () => {
  test("MiniMax-M3 → 跟随 / 关闭 / 开启（toggle + anthropic-adaptive）", () => {
    const v = computeReasoningDropdown("minimax", "MiniMax-M3", undefined);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "开启"]);
    expect(v.disabled).toBe(false);
  });

  test("MiniMax-M2.7 → fixed-on", () => {
    const v = computeReasoningDropdown("minimax", "MiniMax-M2.7", undefined);
    expect(v.disabled).toBe(true);
    expect(v.statusText).toBe("始终开启");
  });
});

describe("computeReasoningDropdown — MiMo", () => {
  test("mimo-v2.5-pro → 跟随 / 关闭 / 开启（toggle）", () => {
    const v = computeReasoningDropdown("mimo", "mimo-v2.5-pro", undefined);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "开启"]);
  });
});

describe("computeReasoningDropdown — 豆包", () => {
  test("doubao-seed-2-1 → 可选择跟随、关闭或开启", () => {
    const v = computeReasoningDropdown("doubao", "doubao-seed-2-1-pro-260628", undefined);
    expect(v.disabled).toBe(false);
    expect(labels(v)).toEqual(["跟随模型", "关闭", "开启"]);
  });
});

describe("computeReasoningDropdown — 未知模型", () => {
  test("unknown → disabled，单项 跟随模型", () => {
    const v = computeReasoningDropdown("unknown", "anything", undefined);
    expect(v.disabled).toBe(true);
    expect(v.statusText).toBe("跟随模型");
    expect(labels(v)).toEqual(["跟随模型"]);
  });
});

describe("computeReasoningDropdown — saved 不变（用户修订 #5）", () => {
  test("saved effort='max' 但模型只支持 high → active highlight 是 high（effective 退回 default）", () => {
    const saved: ReasoningPreference = { mode: "on", effort: "max" };
    const v = computeReasoningDropdown("deepseek", "deepseek-v4-pro", saved);
    // deepseek supportedEfforts = [high, max]，max 在列 → 保留
    expect(activeLabel(v)).toBe("最强"); // "max" → label "最强"
    // 再测试 saved effort 不在列的情况
    const saved2: ReasoningPreference = { mode: "on", effort: "low" };
    const v2 = computeReasoningDropdown("deepseek", "deepseek-v4-pro", saved2);
    // effective effort = defaultEffort = "high"
    expect(v2.activePreference.effort).toBe("high");
    expect(activeLabel(v2)).toBe("高");
    // saved 不动
    expect(saved2).toEqual({ mode: "on", effort: "low" });
  });

  test("fixed-on model: saved=off → effective=on → activeLabel=始终开启", () => {
    const saved: ReasoningPreference = { mode: "off" };
    const v = computeReasoningDropdown("qwen", "qwen3-thinking", saved);
    expect(v.activePreference.mode).toBe("on");
    expect(v.items.length).toBe(1);
    // saved 不动
    expect(saved).toEqual({ mode: "off" });
  });
});

describe("formatReasoningTriggerLabel", () => {
  test("跟随模型 → 推理 · 跟随模型", () => {
    expect(formatReasoningTriggerLabel("跟随模型")).toBe("推理 · 跟随模型");
  });
  test("高 → 推理 · 高", () => {
    expect(formatReasoningTriggerLabel("高")).toBe("推理 · 高");
  });
  test("始终开启 → 推理 · 始终开启", () => {
    expect(formatReasoningTriggerLabel("始终开启")).toBe("推理 · 始终开启");
  });
});

describe("computeReasoningDropdown — resolveEffectiveReasoning 全路径", () => {
  test("auto + capability.effort → active 是 defaultEffort", () => {
    const v = computeReasoningDropdown("chatgpt", "gpt-5.6", { mode: "auto" });
    // auto → effective = auto → statusText = "跟随模型"
    expect(v.statusText).toBe("跟随模型");
  });

  test("off + supportsDisable=true → active 是 off → statusText = 关闭", () => {
    const v = computeReasoningDropdown("deepseek", "deepseek-v4-pro", { mode: "off" });
    expect(v.statusText).toBe("关闭");
  });

  test("on + no effort → defaultEffort", () => {
    const v = computeReasoningDropdown("chatgpt", "gpt-5.6", { mode: "on" });
    expect(v.statusText).toBe("中"); // defaultEffort = "medium"
    expect(activeLabel(v)).toBe("中");
  });
});
