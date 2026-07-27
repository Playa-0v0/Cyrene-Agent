import * as fs from "fs";
import * as path from "path";
import { WORLDBOOK_CONSTANTS } from "./worldbook-constants";

// ── Worldbook entry ──
export interface WorldbookEntry {
  id: string;
  keywords: string[];
  content: string;
  priority: number;          // 作者重要性；v3.4 僅作排序 tiebreaker，不參與 DMAE 打分
  permanent: boolean;        // 常駐：始終注入 Prompt，不進 DMAE
  enabled: boolean;
  intrinsicValue: number;    // ★ 長期價值基準（固定）；v3.4 參與 Floor（首次激活基線）和 Resistance（遺忘抵抗），不參與 Reward
  linkTriggers: string[];    // 連帶觸發詞（One-Shot 一次性）：本條目被用戶命中時，連帶觸發這些關鍵詞對應的條目；[] 表示無
}

// ── DMAE runtime state (per entry, keyed by entry.id) ──
// 注意：state 不掛 WorldbookEntry 上——loadFromDirectory 會整表替換 this.entries，
// 掛上面會在重載時丟失。這裡獨立維護一張狀態表。
export interface EntryState {
  activation: number;     // 0..MaxScore
  userSilence: number;    // 距上次用戶命中的輪數
  modelSilence: number;   // 距上次模型命中的輪數
  // 無 state 字段——由 (activation, threshold) 派生（業務層負責，updateActivation 不碰閾值）
}

export type DmaeState = "Active" | "Dormant" | "Archived";

// ── DMAE 可調參數（v4.0 規範）──
// 任何參數都只是默認值，不是結論。所有參數以後都通過 Simulator 調整。
// v4.0 公式:
//   Ru = Bu × (1 + γ · ln(1+U_old))   [僅 userHit]
//   Rm = Bm × e^(−λ·U_old)             [僅 modelHit + Active, 實現層 clamp 保證 Rm < D]
//   D  = (α·U_new² + β·M_new²) / √I
export interface DmaeParams {
  maxScore: number;             // 100：物理上界
  promptThreshold: number;      // 30：>= 此值進 Prompt（業務層用）
  /** 用戶基礎獎勵：每次 userHit 至少漲多少 */
  userRewardBase: number;       // Bu = 20（v4.0 默認）
  /** 久別重逢增益：ln(1+U_old) 的係數，γ 越大久別獎勵越猛 */
  wakeGamma: number;            // γ = 0.5（v4.0 默認）
  /** 模型基礎獎勵：modelHit + Active 時最多給多少 */
  modelRewardBase: number;      // Bm = 8（v4.0 默認）
  /** 模型獎勵衰減率：U_old 越大 Rm 越快趨近 0 */
  wakeLambda: number;           // λ = 0.3（v4.0 默認）
  /** 用戶沉默權重：U 不提時衰減多快（按"8 輪跌破"目標反推 = 1.5） */
  decayAlpha: number;           // α = 1.5
  /** 模型沉默權重：M 不復述時衰減多快（需滿足 α > β） */
  decayBeta: number;            // β = 0.3
}

export const DEFAULT_DMAE_PARAMS: DmaeParams = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3,
};

// ── 策略接口（v4.0 框架固化，以後不再改）──
export interface RewardContext {
  entry: WorldbookEntry;
  snap: { activation: number; userSilence: number; modelSilence: number };
  params: DmaeParams;
}
export interface DecayContext {
  entry: WorldbookEntry;
  snap: { userSilence: number; modelSilence: number };  // 更新後值
  params: DmaeParams;
}

export interface RewardStrategy {
  // v4.0 §4：用戶命中獎勵。Ru = Bu × (1 + γ·ln(1+U_old))
  // 僅當 userHit 時主循環才調用。
  userReward(ctx: RewardContext): number;

  // v4.0 §5：模型維護獎勵。Rm = Bm × e^(−λ·U_old)
  // 僅當 modelHit 時主循環才調用（且 state==Active），主循環負責 clamp 保證 Rm < D。
  modelReward(ctx: RewardContext): number;
}

export interface DecayStrategy {
  compute(ctx: DecayContext): number;
}

// ── v4.0 默認 Reward 策略 ──
// Ru = Bu × (1 + γ · ln(1 + U_old))     [v4.0 §4]
//   - 連續命中 → 至少 Bu
//   - 沉默越久 → ln(1+U) 越大 → 久別重逢獎勵越猛
//   - ln 單調遞增 + 增長變緩 → 永遠不會暴漲（避免無限分）
//
// Rm = Bm × e^(−λ · U_old)             [v4.0 §5]
//   - U_old=0 → 最大 Bm
//   - U_old 越大 → 指數衰減 → 模型話語權越小
//   - Active gating 由主循環控制（v4.0 §5 要求 "當前 Activation ≥ PromptThreshold"）
//   - Rm<D clamp 由主循環控制（v4.0 §8/§9 不變量）
export class DefaultRewardStrategy implements RewardStrategy {
  userReward(ctx: RewardContext): number {
    const { snap, params } = ctx;
    return params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + snap.userSilence));
  }
  modelReward(ctx: RewardContext): number {
    const { snap, params } = ctx;
    return params.modelRewardBase * Math.exp(-params.wakeLambda * snap.userSilence);
  }
}
// I 不參與（避免高價值條目既漲得快又忘得慢而天然霸榜）。

// ── v3.4 默認 Decay 策略 ──
// Decay = (α·US² + β·MS²) / sqrt(I)   [I 僅在 Resistance：高 I = 抵抗強 = 忘得慢]
// 平方 → 累計加速遺忘 §8.1；除以 sqrt(I) → "價值決定忘得多慢，而不是愛得多深"。
export class QuadraticResistanceDecay implements DecayStrategy {
  compute(ctx: DecayContext): number {
    const { entry, snap, params } = ctx;
    const I = Math.max(WORLDBOOK_CONSTANTS.MIN_INTRINSIC_VALUE, entry.intrinsicValue);
    const resistance = 1 / Math.sqrt(I);
    const raw = params.decayAlpha * snap.userSilence * snap.userSilence
              + params.decayBeta * snap.modelSilence * snap.modelSilence;
    return raw * resistance;
  }
}

// ── 狀態派生（純函數，業務層 + 策略層共用）──
// <=0 → Archived；>= threshold → Active；之間 → Dormant
export function deriveState(activation: number, threshold: number): DmaeState {
  if (activation <= 0) return "Archived";
  if (activation >= threshold) return "Active";
  return "Dormant";
}

// ── Worldbook Manager ──
export interface WorldbookManagerOptions {
  params?: Partial<DmaeParams>;
  rewardStrategy?: RewardStrategy;
  decayStrategy?: DecayStrategy;
  stateFile?: string;   // v1 持久化 seam：傳了也暫時只 load/save 空實現，重啟回 0
  debug?: boolean;
}

export class WorldbookManager {
  private entries: WorldbookEntry[] = [];
  private worldbookDir: string;
  private state = new Map<string, EntryState>();
  // ── One-Shot cascade：本輪用戶命中後連帶觸發的條目（不入 DMAE 狀態表，只本輪有效）──
  private lastCascadeEntries: WorldbookEntry[] = [];
  private params: DmaeParams;
  private rewardStrategy: RewardStrategy;
  private decayStrategy: DecayStrategy;
  private stateFile?: string;
  private debug: boolean;

  // 終態注入上限（詳見 worldbook-constants.ts）
  private static readonly MAX_ACTIVE = WORLDBOOK_CONSTANTS.MAX_ACTIVE;

  // .md 未寫 intrinsic value 時的 fallback（詳見 worldbook-constants.ts）
  private static readonly DEFAULT_INTRINSIC_VALUE = WORLDBOOK_CONSTANTS.DEFAULT_INTRINSIC_VALUE;

  constructor(worldbookDir: string, options?: WorldbookManagerOptions) {
    this.worldbookDir = worldbookDir;
    this.params = { ...DEFAULT_DMAE_PARAMS, ...(options?.params ?? {}) };
    this.rewardStrategy = options?.rewardStrategy ?? new DefaultRewardStrategy();
    this.decayStrategy = options?.decayStrategy ?? new QuadraticResistanceDecay();
    this.stateFile = options?.stateFile;
    this.debug = options?.debug ?? true;
  }

  // Load all .md files from the worldbook directory
  async loadFromDirectory(): Promise<void> {
    if (!fs.existsSync(this.worldbookDir)) {
      console.warn("[Worldbook] directory not found:", this.worldbookDir);
      return;
    }

    const files = fs.readdirSync(this.worldbookDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) {
      console.warn("[Worldbook] no .md files found in:", this.worldbookDir);
      return;
    }

    const allEntries: WorldbookEntry[] = [];

    for (const file of files) {
      const filePath = path.join(this.worldbookDir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const entries = this.parseMarkdown(content, file);
      allEntries.push(...entries);
    }

    this.entries = allEntries;

    // 初始化 DMAE 狀態：每條非常駐條目 activation=0（Archived 冷態）
    // 常駐條目不進 DMAE（始終注入），不給它們分配狀態。
    this.state.clear();
    for (const e of this.entries) {
      if (e.enabled && !e.permanent) {
        this.state.set(e.id, { activation: 0, userSilence: 0, modelSilence: 0 });
      }
    }

    // v1 持久化 seam：預留，暫為空（重啟回 0）
    this.loadState();

    console.log(`[Worldbook] loaded ${allEntries.length} entries from ${files.length} files; DMAE state initialized for ${this.state.size} non-permanent entries`);
  }

  // 從內存 entries 加載（不讀 fs）：simulator / 測試用。
  // 複用 loadFromDirectory 的狀態初始化邏輯，保證 sim 和生產用同一套初始化路徑。
  loadFromEntries(entries: WorldbookEntry[]): void {
    this.entries = entries;
    this.state.clear();
    for (const e of this.entries) {
      if (e.enabled && !e.permanent) {
        this.state.set(e.id, { activation: 0, userSilence: 0, modelSilence: 0 });
      }
    }
    this.loadState();
  }

  // Parse markdown format:
  // ## 條目名
  // - 觸發詞: 詞1, 詞2, 詞3
  // - 常駐: 是
  // - 優先級: 200
  // - 內在價值: 60                ← v3.4 新名（與 初始分/initial_score/intrinsic_value 兼容）
  //
  // 內容段落...
  // ---
  private parseMarkdown(content: string, fileName: string): WorldbookEntry[] {
    const entries: WorldbookEntry[] = [];

    // Split by ## headings
    const lines = content.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      // Find next ## heading
      if (!line.startsWith("## ")) {
        i++;
        continue;
      }

      const title = line.replace(/^## /, "").trim();
      i++;

      // Parse metadata lines (lines starting with -)
      let keywords: string[] = [];
      let priority = 5;
      let permanent = false;
      let intrinsicValue = WorldbookManager.DEFAULT_INTRINSIC_VALUE;
      let linkTriggers: string[] = [];
      let contentStart = i;

      while (i < lines.length) {
        const metaLine = lines[i].trim();

        if (metaLine.startsWith("- 觸發詞:") || metaLine.startsWith("- 觸發詞：") ||
            metaLine.startsWith("- 触发词:") || metaLine.startsWith("- 触发词：")) {
          const val = metaLine.replace(/^-\s*(觸發詞|触发词)[：:]/, "").trim();
          keywords = val.split(/[,，、]/).map((k) => k.trim()).filter(Boolean);
          i++;
        } else if (metaLine.startsWith("- 常駐:") || metaLine.startsWith("- 常驻:") ||
                   metaLine.startsWith("- 常駐：") || metaLine.startsWith("- 常驻：")) {
          const val = metaLine.replace(/^-\s*(常駐|常驻)[：:]/, "").trim();
          permanent = val === "是" || val === "yes" || val === "true" || val === "是" || val === "yes" || val === "true";
          i++;
        } else if (metaLine.startsWith("- 優先級:") || metaLine.startsWith("- 優先級：") ||
                   metaLine.startsWith("- 优先级:") || metaLine.startsWith("- 优先级：")) {
          const val = metaLine.replace(/^-\s*(優先級|优先级)[：:]/, "").trim();
          priority = parseInt(val) || 5;
          i++;
        } else if (
          metaLine.startsWith("- 初始分:") || metaLine.startsWith("- 初始分：") ||
          metaLine.startsWith("- initial_score:") || metaLine.startsWith("- initial_score：") ||
          metaLine.startsWith("- 內在價值:") || metaLine.startsWith("- 內在價值：") ||
          metaLine.startsWith("- 内在价值:") || metaLine.startsWith("- 内在价值：") ||
          metaLine.startsWith("- intrinsic_value:") || metaLine.startsWith("- intrinsic_value：")
        ) {
          const val = metaLine.replace(/^-\s*(初始分|initial_score|內在價值|内在价值|intrinsic_value)[：:]/, "").trim();
          const parsed = parseFloat(val);
          intrinsicValue = Number.isFinite(parsed) ? parsed : WorldbookManager.DEFAULT_INTRINSIC_VALUE;
          i++;
        } else if (metaLine.startsWith("- 連帶觸發詞:") || metaLine.startsWith("- 連帶觸發詞：") ||
                   metaLine.startsWith("- 连带触发词:") || metaLine.startsWith("- 连带触发词：") ||
                   metaLine.startsWith("- 連帶觸發:") || metaLine.startsWith("- 連帶觸發：") ||
                   metaLine.startsWith("- 连带触发:") || metaLine.startsWith("- 连带触发：") ||
                   metaLine.startsWith("- link_triggers:") || metaLine.startsWith("- link_triggers：")) {
          const val = metaLine.replace(/^-\s*(連帶觸發詞|连带触发词|連帶觸發|连带触发|link_triggers)[：:]/, "").trim();
          // "無" / "无" / "" 表示不連帶
          if (val && val !== "無" && val !== "无" && val !== "none" && val !== "-") {
            linkTriggers = val.split(/[,，、]/).map((k) => k.trim()).filter(Boolean);
          }
          i++;
        } else if (metaLine.startsWith("---")) {
          // Separator line — stop metadata parsing
          i++;
          break;
        } else if (metaLine === "" || metaLine.startsWith("# ")) {
          // Empty line or top-level heading — stop
          break;
        } else if (metaLine.startsWith("- ")) {
          // Unknown metadata field — skip
          i++;
        } else {
          // Content line — stop metadata parsing
          break;
        }
      }

      // Collect content until next ## or ---
      const contentLines: string[] = [];
      while (i < lines.length) {
        const cl = lines[i];
        if (cl.trim().startsWith("## ") || cl.trim() === "---") {
          break;
        }
        contentLines.push(cl);
        i++;
      }

      const entryContent = contentLines.join("\n").trim();
      if (entryContent) {
        entries.push({
          id: `wb_${fileName.replace(/\.md$/, "")}_${title.replace(/\s+/g, "_")}`,
          keywords,
          content: entryContent,
          priority,
          permanent,
          enabled: true,
          intrinsicValue,
          linkTriggers,
        });
      }
      // suppress unused-var lint for contentStart (kept for parity with original structure)
      void contentStart;
    }

    return entries;
  }

  // ── DMAE 打分層：每輪更新所有條目的 Activation/US/MS ──
  // v3.4 收口公式：
  //   reward = userHit ? rewardGain × Wake(US_old) × Eff(A_old) : 0   (I 不參與 Reward)
  //   decay  = (α·US_new² + β·MS_new²) / sqrt(I)                       (I 僅在 Resistance)
  //   A_new  = clamp(A_old + reward - decay, 0, MaxScore)
  //   if userHit && A_old 狀態 == Archived: A_new = max(A_new, I)      (★ 僅 Archived 復活時 floor；I 參與 Floor 基線)
  // MS 語義：距離最近一次"進入上下文"的輪數（userHit 或 modelHit 都重置），不是"模型有沒有說過"
  // ModelHit：只重置 msNew = 0，不給任何 reward（模型沒有興趣表達權 §7.3/§7.4）
  // Snapshot 語義：每條 entry 獨立、先讀舊值再統一寫，互不影響（DMAE §4/§11.1）。
  updateActivation(userText: string, modelText: string): void {
    const user = userText ?? "";
    const model = modelText ?? "";
    const params = this.params;
    const max = params.maxScore;
    const changed: Array<{ id: string; aOld: number; aNew: number; reason: string }> = [];

    // ── 第一遍：收集本輪所有 userHit 條目 id（cascade 通道用，DMAE 主循環也要）──
    const userHitEntryIds = new Set<string>();
    for (const entry of this.entries) {
      if (!entry.enabled || entry.permanent) continue;
      if (entry.keywords.length === 0) continue;
      if (entry.keywords.some((kw) => user.includes(kw))) {
        userHitEntryIds.add(entry.id);
      }
    }

    for (const entry of this.entries) {
      if (!entry.enabled || entry.permanent) continue;
      if (entry.keywords.length === 0) continue;

      const st = this.state.get(entry.id);
      if (!st) continue;

      // ─ snapshot old ─
      const aOld = st.activation;
      const usOld = st.userSilence;
      const msOld = st.modelSilence;

      // ─ hits ─
      const userHit = entry.keywords.some((kw) => user.includes(kw));
      const modelHit = entry.keywords.some((kw) => model.includes(kw));

      // ─ silence update ─
      const usNew = userHit ? 0 : usOld + 1;
      // MS = 距離最近一次"進入上下文"的輪數。用戶主動提 OR 模型自然提都屬於"進入上下文"，
      // 所以 userHit 也重置 ms——否則用戶連續提但模型不復述時 ms 累積導致 decay 上升、A 反而下降。
      const msNew = (userHit || modelHit) ? 0 : msOld + 1;

      // ─ positive: user reward（僅 userHit，I 不參與） ─
      const userReward = userHit
        ? this.rewardStrategy.userReward({ entry, snap: { activation: aOld, userSilence: usOld, modelSilence: msOld }, params })
        : 0;

      // ─ negative: decay（I 僅在 Resistance） ─
      const decay = this.decayStrategy.compute({
        entry,
        snap: { userSilence: usNew, modelSilence: msNew },
        params,
      });

      // ─ positive: model reward（僅 modelHit + Active gating） ─
      // v4.0 §5：Rm = Bm·e^(-λ·U_old)，僅當 A ≥ PromptThreshold 時給分
      // v4.0 §8 不變量：Rm < D 嚴格成立，由主循環 clamp 保證（避免 Rm ≥ D 時仍能漲分）
      let modelReward = 0;
      if (modelHit && deriveState(aOld, params.promptThreshold) === WORLDBOOK_CONSTANTS.STATES.ACTIVE) {
        const rawRm = this.rewardStrategy.modelReward({ entry, snap: { activation: aOld, userSilence: usOld, modelSilence: msOld }, params });
        // 不變量 clamp：Rm = min(Rm, D - ε)
        modelReward = Math.max(0, Math.min(rawRm, decay - WORLDBOOK_CONSTANTS.EPSILON));
      }

      // ─ commit ─
      let aNew = aOld + userReward + modelReward - decay;
      aNew = Math.max(0, aNew);
      // ★ Floor 僅在 Archived 復活時觸發（避免高價值條目每次命中都 floor 讓 Decay/Wake 失效）
      if (userHit && deriveState(aOld, params.promptThreshold) === WORLDBOOK_CONSTANTS.FLOOR_TRIGGER_STATE) {
        aNew = Math.max(aNew, entry.intrinsicValue);
      }
      aNew = Math.min(max, aNew);

      st.activation = aNew;
      st.userSilence = usNew;
      st.modelSilence = msNew;

      if (this.debug && (userHit || modelHit || Math.abs(aNew - aOld) >= 0.05)) {
        const reasons: string[] = [];
        if (userHit) reasons.push(`U+${userReward.toFixed(2)}`);
        if (modelHit) reasons.push(`M+${modelReward.toFixed(2)}`);
        if (decay > 0) reasons.push(`D-${decay.toFixed(2)}`);
        if (userHit && deriveState(aOld, params.promptThreshold) === WORLDBOOK_CONSTANTS.FLOOR_TRIGGER_STATE) reasons.push(`floor→${entry.intrinsicValue}`);
        changed.push({ id: entry.id, aOld, aNew, reason: reasons.join(" ") });
      }
    }

    if (this.debug && changed.length > 0) {
      console.log(`[Worldbook/DMAE] update: ${changed.length} entries changed`);
      for (const c of changed.slice(0, 12)) {
        console.log(`  ${c.id}: ${c.aOld.toFixed(1)} → ${c.aNew.toFixed(1)}  (${c.reason})`);
      }
    }

    // ── One-Shot 聯動觸發（不入 DMAE 狀態表，只本輪有效）──
    // 規則：只有 userHit 的條目才有連帶觸發權；cascade 目標不再級聯（1 層封頂）。
    // 防死循環 3 條硬約束：
    //   1. 1 層封頂：cascade 只從 userHit 觸發，cascade 目標不會再 cascade
    //   2. userHit 攔截：cascade 目標已在 userHit 列表則跳過（已被主動激活）
    //   3. cascade 集合去重：同條目本輪只 cascade 一次
    this.lastCascadeEntries = [];
    const cascadeInjected = new Set<string>();
    for (const entry of this.entries) {
      if (!userHitEntryIds.has(entry.id)) continue;
      if (entry.linkTriggers.length === 0) continue;
      if (entry.permanent || !entry.enabled) continue;

      // 找 linkTriggers 對應的子條目（關鍵詞命中）
      const targets = this.entries.filter(e =>
        e.enabled && !e.permanent &&
        e.keywords.some(kw => entry.linkTriggers.includes(kw))
      );

      for (const target of targets) {
        // 硬約束 2：跳過 userHit
        if (userHitEntryIds.has(target.id)) continue;
        // 硬約束 3：cascade 去重
        if (cascadeInjected.has(target.id)) continue;

        cascadeInjected.add(target.id);
        this.lastCascadeEntries.push(target);
      }
    }

    if (this.debug && this.lastCascadeEntries.length > 0) {
      console.log(`[Worldbook/Cascade] ${this.lastCascadeEntries.length} entries one-shot injected: ${this.lastCascadeEntries.map(e => e.id).join(", ")}`);
    }
  }

  // 取本輪 One-Shot cascade 觸發的條目（僅供 orchestrator 注入用，不進 DMAE 狀態表）
  getCascadeEntries(): WorldbookEntry[] {
    return [...this.lastCascadeEntries];
  }

  // ── 業務層：閾值門控 + 注入 ──
  // deriveState(activation, promptThreshold)=="Active" 的條目注入；按 activation 降序、priority 降序 tiebreak、截 MAX_ACTIVE。
  getActiveEntries(promptThreshold?: number): string[] {
    const th = promptThreshold ?? this.params.promptThreshold;
    const active = this.entries
      .filter((e) => {
        if (!e.enabled || e.permanent) return false;
        const st = this.state.get(e.id);
        if (!st) return false;
        return deriveState(st.activation, th) === WORLDBOOK_CONSTANTS.STATES.ACTIVE;
      })
      .sort((a, b) => {
        const sa = this.state.get(a.id)!.activation;
        const sb = this.state.get(b.id)!.activation;
        if (sb !== sa) return sb - sa;
        return b.priority - a.priority;
      })
      .slice(0, WorldbookManager.MAX_ACTIVE);

    if (this.debug && active.length > 0) {
      console.log(`[Worldbook/DMAE] active entries injected: ${active.length} (threshold=${th})`);
    }
    // 返回帶條目標題的完整內容（模型需要知道這段設定在說誰）
    return active.map((e) => {
      // 從 entry.id 還原可讀標題：wb_<file>_<title> → <title>
      const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
      return `【${title}】\n${e.content}`;
    });
  }

  // Get permanent entries (常駐) — always included, bypass DMAE
  getPermanentEntries(): string[] {
    return this.entries
      .filter((e) => e.enabled && e.permanent)
      .sort((a, b) => b.priority - a.priority)
      .map((e) => e.content);
  }

  // Get all registered trigger words (legacy, kept for compatibility)
  getAllTriggerWords(): string[] {
    const words = new Set<string>();
    for (const entry of this.entries) {
      for (const kw of entry.keywords) {
        words.add(kw);
      }
    }
    return [...words];
  }

  get entriesCount(): number {
    return this.entries.length;
  }

  // ── 只讀訪問器（simulator / 調試用）──
  getEntries(): readonly WorldbookEntry[] {
    return this.entries;
  }

  getState(id: string): EntryState | undefined {
    return this.state.get(id);
  }

  // ── 持久化 seam（v1 no-op；後續接 JsonVectorStore 同款 sync JSON）──
  private loadState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: fs.readFileSync(this.stateFile) → 反序列化到 this.state
    // 暫不落盤，重啟回 0（已確認 v1 接受）
  }

  private saveState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: fs.writeFileSync(this.stateFile, JSON.stringify([...this.state]))
  }
}
