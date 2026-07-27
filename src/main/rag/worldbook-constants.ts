// ── Worldbook 集中常量 ──
// 維護原則：所有"魔法數字"都集中在這裡，方便後續調參。
// 算法參數（Bu/Bm/γ/λ/α/β 等）走 DmaeParams；這裡只放非算法常量。

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
  // ── State machine 業務參數 ──
  MAX_ACTIVE: 8,                   // 終態注入上限（Scheduler 層硬上限，未來 v4 換 token-budget 背包）
  DEFAULT_INTRINSIC_VALUE: 60,     // .md 未寫 內在價值/初始分/intrinsic_value 時的 fallback

  // ── 數值安全 ──
  MIN_INTRINSIC_VALUE: 1,          // QuadraticResistanceDecay 除零保護：sqrt(0) 會爆
  EPSILON: 0.01,                   // Rm < D 不變量保護：Rm = clamp(Rm, 0, D - ε)

  // ── Floor 語義 ──
  FLOOR_TRIGGER_STATE: "Archived", // 僅 Archived 復活時觸發 Floor（v3.4 已確立）

  // ── 狀態標籤（導出來避免字符串散落各處） ──
  STATES: {
    ACTIVE: "Active",
    DORMANT: "Dormant",
    ARCHIVED: "Archived",
  },
};

// 注入 Prompt 時使用的標籤（orchestrator 拼接 .md 內容時引用）
export const INJECTION_HEADER = "【已激活的世界知識】";
export const INJECTION_PREAMBLE =
  "以下內容已由當前用戶消息觸發，視為真實且已知。回覆時請自然使用這些信息，不要說「不知道」、「第一次聽說」或要求用戶介紹，除非內容本身存在矛盾。";