// ContextUsageRing 单测：纯函数口径 + 静态渲染断言（renderToStaticMarkup，项目惯例）。
//
// 重点覆盖施工文档 Phase 3 验收点：
// - visualRatio clamp（含 ratio>1：文本诚实显示 117%，圆环 clamp 整圈）
// - contextWindowTokens<=0 / NaN：不渲染进度弧与百分比，菜单仍显示绝对值
// - 分级变色（normal / warm≥70% / alert≥90%）
// - 无快照返回 null；0 token 类别在菜单中隐藏；数字格式化
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextUsageCategoryKey, ContextUsageSnapshot } from "../../../../../shared/context-usage";

// JSX 经典运行时（React.createElement）：被测 .tsx 需要全局 React（项目测试惯例）。
vi.stubGlobal("React", React);

vi.mock("antd", async () => {
  const ReactModule = await import("react");
  return {
    // 直渲 children + content，让静态 markup 能同时断言圆环与菜单。
    Popover: ({ children, content }: { children?: unknown; content?: unknown }) =>
      ReactModule.createElement("div", null, children as React.ReactNode, content as React.ReactNode),
  };
});

// 项目惯例：resolveAsset 在测试里直通，断言相对路径即可。
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import {
  CONTEXT_USAGE_CATEGORY_META,
  CONTEXT_USAGE_COMPACT_SRC,
  CONTEXT_USAGE_MOOD_META,
  ContextUsageRing,
  RING_CIRCUMFERENCE,
  clampVisualRatio,
  computeUsageRatio,
  formatTokenCount,
  resolveRingTone,
} from "./ContextUsageRing";

const CATEGORY_KEYS: ContextUsageCategoryKey[] = [
  "systemPrompt",
  "tools",
  "skills",
  "runtimeAndToolLogs",
  "conversation",
  "other",
];

function snapshotOf(input: {
  categories?: Partial<Record<ContextUsageCategoryKey, number>>;
  contextWindowTokens?: number;
  totalTokens?: number;
}): ContextUsageSnapshot {
  const values = input.categories ?? { systemPrompt: 1000, conversation: 500 };
  const categories = CATEGORY_KEYS.map((key) => ({ key, tokens: values[key] ?? 0 }));
  return {
    phase: "terminal",
    contextWindowTokens: input.contextWindowTokens ?? 256_000,
    totalTokens: input.totalTokens ?? categories.reduce((sum, category) => sum + category.tokens, 0),
    categories,
    messageCount: 3,
    updatedAt: Date.now(),
  };
}

/** 从 markup 提取进度弧的 stroke-dasharray，返回 [弧长, 周长]。 */
function extractDasharray(markup: string): [number, number] | undefined {
  const match = markup.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

describe("context usage helpers", () => {
  it("formats token counts as k notation only above 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12_345)).toBe("12.3k");
    expect(formatTokenCount(123_456)).toBe("123k");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });

  it("computes the usage ratio and returns NaN for invalid windows", () => {
    expect(computeUsageRatio(12_800, 256_000)).toBeCloseTo(0.05);
    expect(Number.isNaN(computeUsageRatio(100, 0))).toBe(true);
    expect(Number.isNaN(computeUsageRatio(100, -5))).toBe(true);
    expect(Number.isNaN(computeUsageRatio(Number.NaN, 100))).toBe(true);
    expect(computeUsageRatio(0, 100)).toBe(0);
  });

  it("clamps the visual ratio fed into the svg arc", () => {
    expect(clampVisualRatio(0.42)).toBeCloseTo(0.42);
    expect(clampVisualRatio(1.18)).toBe(1);
    expect(clampVisualRatio(-0.2)).toBe(0);
    expect(clampVisualRatio(Number.NaN)).toBe(0);
    expect(clampVisualRatio(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("grades the ring tone at compression and overflow thresholds", () => {
    expect(resolveRingTone(0.05)).toBe("normal");
    expect(resolveRingTone(0.69)).toBe("normal");
    expect(resolveRingTone(0.7)).toBe("warm");
    expect(resolveRingTone(0.89)).toBe("warm");
    expect(resolveRingTone(0.9)).toBe("alert");
    expect(resolveRingTone(1.4)).toBe("alert");
    expect(resolveRingTone(Number.NaN)).toBe("normal");
  });
});

describe("ContextUsageRing rendering", () => {
  it("renders nothing without a snapshot", () => {
    expect(renderToStaticMarkup(React.createElement(ContextUsageRing, { usage: undefined }))).toBe("");
  });

  it("renders a normal-tone ring with title summary", () => {
    const markup = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ categories: { systemPrompt: 12_800, conversation: 0 } }),
    }));
    expect(markup).toContain("cy-context-usage-ring is-normal");
    expect(markup).toContain("上下文 12.8k / 256k (5%)");
    const dash = extractDasharray(markup);
    expect(dash).toBeDefined();
    expect(dash![1]).toBeCloseTo(RING_CIRCUMFERENCE);
    expect(dash![0] / dash![1]).toBeCloseTo(0.05, 2);
  });

  it("clamps an over-window ratio to a full ring while keeping the honest percentage", () => {
    const markup = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ totalTokens: 300_000, categories: { conversation: 300_000 } }),
    }));
    // 300k / 256k = 117.1875% → 文本诚实显示 117%，圆环整圈，色调 alert。
    expect(markup).toContain("117%");
    expect(markup).toContain("cy-context-usage-ring is-alert");
    const dash = extractDasharray(markup);
    expect(dash![0]).toBeCloseTo(RING_CIRCUMFERENCE);
    expect(dash![0] / dash![1]).toBeCloseTo(1);
  });

  it("omits the progress arc and percentage when the context window is invalid", () => {
    const markup = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ contextWindowTokens: 0, categories: { systemPrompt: 1500 } }),
    }));
    expect(markup).toContain("cy-context-usage-ring__track");
    expect(markup).not.toContain("cy-context-usage-ring__progress");
    // 无窗口比例：标题不带容量百分比（堆叠条的 width:100% 是 CSS，不算）。
    expect(markup).not.toContain("tokens (");
    // 明细行仍显示占已用百分比（1500/1500 = 100%）。
    expect(markup).toContain("cy-context-usage-menu__share");
    expect(markup).toContain(">100%</span>");
    // 菜单仍显示绝对 token 值。
    expect(markup).toContain("1.5k tokens");
  });

  it("grades to warm tone at 70% occupancy", () => {
    const markup = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ categories: { conversation: 184_320 } }), // 184320/256000 = 0.72
    }));
    expect(markup).toContain("cy-context-usage-ring is-warm");
    expect(markup).toContain("(72%)");
  });

  it("switches the mood mascot and caption by tone", () => {
    const normal = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ categories: { conversation: 12_800 } }), // 5%
    }));
    expect(normal).toContain("cy-context-usage-menu__mood is-normal");
    expect(normal).toContain(CONTEXT_USAGE_MOOD_META.normal.src);
    expect(normal).toContain(CONTEXT_USAGE_MOOD_META.normal.text);

    const warm = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ categories: { conversation: 184_320 } }), // 72%
    }));
    expect(warm).toContain("cy-context-usage-menu__mood is-warm");
    expect(warm).toContain(CONTEXT_USAGE_MOOD_META.warm.src);
    expect(warm).toContain(CONTEXT_USAGE_MOOD_META.warm.text);

    const alert = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ totalTokens: 300_000, categories: { conversation: 300_000 } }), // 117%
    }));
    expect(alert).toContain("cy-context-usage-menu__mood is-alert");
    expect(alert).toContain(CONTEXT_USAGE_MOOD_META.alert.src);
    expect(alert).toContain(CONTEXT_USAGE_MOOD_META.alert.text);
  });

  it("renders the compact mascot crossfade layer and stays inert without a sessionId", () => {
    // 无 sessionId：小人不可点击（无 can-compact），按钮 disabled，但仍渲染压缩图层。
    const inert = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ categories: { conversation: 12_800 } }),
    }));
    expect(inert).toContain(CONTEXT_USAGE_COMPACT_SRC);
    expect(inert).not.toContain("can-compact");
    expect(inert).toContain("cy-context-usage-menu__mood-figure\" disabled");
  });

  it("enables the compact trigger with a sessionId and disables it while busy", () => {
    const usage = snapshotOf({ categories: { conversation: 12_800 } });
    const enabled = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage,
      sessionId: "session-1",
    }));
    expect(enabled).toContain("cy-context-usage-menu__mood is-normal can-compact");
    expect(enabled).toContain(CONTEXT_USAGE_COMPACT_SRC);
    expect(enabled).not.toContain("cy-context-usage-menu__mood-figure\" disabled");

    // 模型运行中：压缩禁用，避免与 run 的消息写回竞态。
    const busy = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage,
      sessionId: "session-1",
      busy: true,
    }));
    expect(busy).not.toContain("can-compact");
    expect(busy).toContain("cy-context-usage-menu__mood-figure\" disabled");
  });

  it("renders the popover menu with a single progress bar and per-category rows, hiding zero-token categories", () => {
    const markup = renderToStaticMarkup(React.createElement(ContextUsageRing, {
      usage: snapshotOf({ categories: { systemPrompt: 12_800, tools: 51_200, conversation: 12_800 } }),
    }));
    // 菜单结构：标题 + 汇总 + 脚注。
    expect(markup).toContain("上下文容量");
    expect(markup).toContain("估算值（按字符折算），对话后自动刷新");
    // 单条总占比进度条（normal 档）。
    expect((markup.match(/cy-context-usage-menu__progress is-normal/g) ?? []).length).toBe(1);
    expect((markup.match(/cy-context-usage-menu__dot"/g) ?? []).length).toBe(3);
    // 0 token 的技能、运行时与日志、其他被隐藏。
    expect(markup).not.toContain(CONTEXT_USAGE_CATEGORY_META.skills.label);
    expect(markup).not.toContain(CONTEXT_USAGE_CATEGORY_META.runtimeAndToolLogs.label);
    expect(markup).not.toContain(CONTEXT_USAGE_CATEGORY_META.other.label);
    // 明细行：类别名 + token 数 + 占已用百分比（51.2k/76.8k = 67%），各类加总 100%。
    expect(markup).toContain(CONTEXT_USAGE_CATEGORY_META.tools.label);
    expect(markup).toContain("51.2k");
    expect(markup).toContain(">67%</span>");
    expect(markup).toContain(">17%</span>");
    // 按 token 从大到小排队：tools(51.2k) 在 systemPrompt(12.8k) 之前。
    expect(markup.indexOf(CONTEXT_USAGE_CATEGORY_META.tools.label))
      .toBeLessThan(markup.indexOf(CONTEXT_USAGE_CATEGORY_META.systemPrompt.label));
    // 圆点统一主题色（CSS 提供），透明度按位次递减：榜首 1，次席 0.85，第三 0.7。
    expect(markup).toContain(`cy-context-usage-menu__dot" style="opacity:1`);
    expect(markup).toContain(`cy-context-usage-menu__dot" style="opacity:0.85`);
    expect(markup).toContain(`cy-context-usage-menu__dot" style="opacity:0.7`);
  });
});
