// ── Worldbook 集中常量 ──
// 维护原则：所有"魔法数字"都集中在这里，方便后续调参。
// 算法参数（Bu/Bm/γ/λ/α/β 等）走 DmaeParams；这里只放非算法常量。

export const WORLDBOOK_CONSTANTS: {
  MAX_ACTIVE: number;
  DEFAULT_INTRINSIC_VALUE: number;
  MIN_INTRINSIC_VALUE: number;
  EPSILON: number;
  FLOOR_TRIGGER_STATE: string;
  STATES: {
    readonly ACTIVE: "Active";
    readonly DORMANT: "Dormant";
    readonly ARCHIVED: "Archived";
  };
} = {
  // ── State machine 业务参数 ──
  MAX_ACTIVE: 8,                   // 终态注入上限（Scheduler 层硬上限，未来 v4 换 token-budget 背包）
  DEFAULT_INTRINSIC_VALUE: 60,     // .md 未写 内在价值/初始分/intrinsic_value 时的 fallback

  // ── 数值安全 ──
  MIN_INTRINSIC_VALUE: 1,          // QuadraticResistanceDecay 除零保护：sqrt(0) 会爆
  EPSILON: 0.01,                   // Rm < D 不变量保护：Rm = clamp(Rm, 0, D - ε)

  // ── Floor 语义 ──
  FLOOR_TRIGGER_STATE: "Archived", // 仅 Archived 复活时触发 Floor（v3.4 已确立）

  // ── 状态标签（导出来避免字符串散落各处） ──
  STATES: {
    ACTIVE: "Active",
    DORMANT: "Dormant",
    ARCHIVED: "Archived",
  },
};

// 注入 Prompt 时使用的标签（orchestrator 拼接 .md 内容时引用）
export const INJECTION_HEADER = "【已激活的世界知识】";
export const INJECTION_PREAMBLE =
  "以下内容已由当前用户消息触发，视为真实且已知。回复时请自然使用这些信息，不要说「不知道」、「第一次听说」或要求用户介绍，除非内容本身存在矛盾。";