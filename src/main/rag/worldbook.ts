// 注：注释中的 "V5 §x" / "v4.0 §x" 均指 docs/specs/2026-08-08-dmae-v5-upgrade-and-l2-working-memory.md（DMAE 世界书升级设计）。
import * as fs from "fs";
import * as path from "path";
import { WORLDBOOK_CONSTANTS } from "./worldbook-constants";
import { logger, LogTag } from "../logger";

// ── Worldbook entry ──
export interface WorldbookEntry {
  id: string;
  keywords: string[];
  content: string;
  priority: number;          // 作者重要性；v3.4 仅作排序 tiebreaker，不参与 DMAE 打分
  permanent: boolean;        // 常驻：始终注入 Prompt，不进 DMAE
  enabled: boolean;
  intrinsicValue: number;    // ★ 长期价值基准（固定）；v3.4 参与 Floor（首次激活基线）和 Resistance（遗忘抵抗），不参与 Reward
  linkTriggers: string[];    // 连带触发词（One-Shot 一次性）：本条目被用户命中时，连带触发这些关键词对应的条目；[] 表示无
}

// ── DMAE 通用条目接口 ──
// WorldbookEntry 与 L2Memory 都可通过 adapter 实现此接口，复用同一套 DMAE 引擎。
export interface DmaeEntry {
  id: string;
  keywords: string[];        // 命中检测用；L2 用 content 分词 / evidence 实体
  intrinsicValue: number;    // 抗遗忘能力；L2 召回时按位次临时赋值
  permanent: boolean;        // 常驻：旁路 DMAE；L2 的 isPinned 映射到此
  enabled: boolean;
}

// ── DMAE runtime state (per entry, keyed by entry.id) ──
// 注意：state 不挂 WorldbookEntry 上——loadFromDirectory 会整表替换 this.entries，
// 挂上面会在重载时丢失。这里独立维护一张状态表。
export interface EntryState {
  activation: number;     // 0..MaxScore
  userSilence: number;    // 距上次用户命中的轮数
  modelSilence: number;   // 距上次模型命中的轮数
  recentUserHits: number[]; // V5 §5.5：最近 repeatWindow 轮内的用户命中轮次编号
  // 无 state 字段——由 (activation, threshold) 派生（业务层负责，updateActivation 不碰阈值）
}

export type DmaeState = "Active" | "Dormant" | "Archived";

// ── DMAE 可调参数（v5.1 规范）──
// 任何参数都只是默认值，不是结论。所有参数以后都通过 Simulator 调整。
// v5.1 公式:
//   Ru* = Bu × (1 + γ · ln(1+U_old)) × G_sat × G_repeat   [仅 userHit]
//   Rm  = Bm × e^(−λ·U_old)                               [仅 modelHit + Active]
//   D   = (α·U_new² + β·M_new²) / √I
//   G_sat     = (1 - A_old/A_max)^p
//   G_repeat  = 1 / (1 + ρ · n_w)
export interface DmaeParams {
  maxScore: number;             // 100：物理上界
  promptThreshold: number;      // 30：>= 此值进 Prompt（业务层用）
  /** 用户基础奖励：每次 userHit 至少涨多少 */
  userRewardBase: number;       // Bu = 20（v4.0 默认）
  /** 久别重逢增益：ln(1+U_old) 的系数，γ 越大久别奖励越猛 */
  wakeGamma: number;            // γ = 0.5（v4.0 默认）
  /** 模型基础奖励：modelHit + Active 时最多给多少 */
  modelRewardBase: number;      // Bm = 8（v4.0 默认）
  /** 模型奖励衰减率：U_old 越大 Rm 越快趋近 0 */
  wakeLambda: number;           // λ = 0.3（v4.0 默认）
  /** 用户沉默权重：U 不提时衰减多快（按"8 轮跌破"目标反推 = 1.5） */
  decayAlpha: number;           // α = 1.5（worldbook 维持 V4 值；L2 专用实例可调高）
  /** 模型沉默权重：M 不复述时衰减多快（需满足 α > β） */
  decayBeta: number;            // β = 0.3（worldbook 维持 V4 值；L2 专用实例可调低）
  /** 重复抑制强度：ρ 越大，短期内重复命中奖励越低 */
  repeatRho: number;            // ρ = 0.5（V5 新增）
  /** 饱和抑制幂次：p 决定接近 A_max 时奖励压缩速度 */
  satPower: number;             // p = 2（V5 新增）
  /** 重复统计窗口：最近多少轮内命中算"重复" */
  repeatWindow: number;         // w = 6（V5 新增）
  /** 唤醒补偿：Archived 复活时的初始 activation 加成（A_init = T_active + B_w） */
  wakeBonus: number;            // B_w = 5（V5 新增）
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
  repeatRho: 0.5,
  satPower: 2,
  repeatWindow: 6,
  wakeBonus: 5,
};

// ── 策略接口（v4.0 框架固化，以后不再改）──
export interface RewardContext<T extends DmaeEntry = DmaeEntry> {
  entry: T;
  snap: { activation: number; userSilence: number; modelSilence: number };
  params: DmaeParams;
  /** V5 §5.5：当前重复窗口内用户命中次数（含本轮） */
  recentHitCount: number;
}
export interface DecayContext<T extends DmaeEntry = DmaeEntry> {
  entry: T;
  snap: { userSilence: number; modelSilence: number };  // 更新后值
  params: DmaeParams;
}

export interface RewardStrategy<T extends DmaeEntry = DmaeEntry> {
  // v4.0 §4：用户命中奖励。Ru = Bu × (1 + γ·ln(1+U_old))
  // 仅当 userHit 时主循环才调用。
  userReward(ctx: RewardContext<T>): number;

  // v4.0 §5：模型维护奖励。Rm = Bm × e^(−λ·U_old)
  // 仅当 modelHit 时主循环才调用（且 state==Active），主循环负责 clamp 保证 Rm < D。
  modelReward(ctx: RewardContext<T>): number;
}

export interface DecayStrategy<T extends DmaeEntry = DmaeEntry> {
  compute(ctx: DecayContext<T>): number;
}

// ── V5.1 饱和抑制 / 重复抑制门控函数 ──
function gateSaturation(activation: number, p: number, aMax: number): number {
  if (activation >= aMax) return 0;
  return Math.pow(1 - activation / aMax, p);
}
function gateRepeat(hitCount: number, rho: number): number {
  return 1 / (1 + rho * hitCount);
}

// ── V5.1 默认 Reward 策略 ──
// Ru* = Bu × (1 + γ · ln(1 + U_old)) × G_sat × G_repeat   [V5 §5.6]
//   G_sat  = (1 - A_old/A_max)^p                         [V5 §5.4]
//   G_rep  = 1 / (1 + ρ · n_w)                           [V5 §5.5]
// Rm = Bm × e^(−λ · U_old)                              [V5 §5.3]
export class DefaultRewardStrategy<T extends DmaeEntry = DmaeEntry> implements RewardStrategy<T> {
  userReward(ctx: RewardContext<T>): number {
    const { snap, params, recentHitCount } = ctx;
    const base = params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + snap.userSilence));
    const gSat = gateSaturation(snap.activation, params.satPower, params.maxScore);
    const gRep = gateRepeat(recentHitCount, params.repeatRho);
    return base * gSat * gRep;
  }
  modelReward(ctx: RewardContext<T>): number {
    const { snap, params } = ctx;
    return params.modelRewardBase * Math.exp(-params.wakeLambda * snap.userSilence);
  }
}
// I 不参与（避免高价值条目既涨得快又忘得慢而天然霸榜）。

// ── v3.4 默认 Decay 策略 ──
// Decay = (α·US² + β·MS²) / sqrt(I)   [I 仅在 Resistance：高 I = 抵抗强 = 忘得慢]
// 平方 → 累计加速遗忘 §8.1；除以 sqrt(I) → "价值决定忘得多慢，而不是爱得多深"。
export class QuadraticResistanceDecay<T extends DmaeEntry = DmaeEntry> implements DecayStrategy<T> {
  compute(ctx: DecayContext<T>): number {
    const { entry, snap, params } = ctx;
    const I = Math.max(WORLDBOOK_CONSTANTS.MIN_INTRINSIC_VALUE, entry.intrinsicValue);
    const resistance = 1 / Math.sqrt(I);
    const raw = params.decayAlpha * snap.userSilence * snap.userSilence
              + params.decayBeta * snap.modelSilence * snap.modelSilence;
    return raw * resistance;
  }
}

// ── 状态派生（纯函数，业务层 + 策略层共用）──
// <=0 → Archived；>= threshold → Active；之间 → Dormant
export function deriveState(activation: number, threshold: number): DmaeState {
  if (activation <= 0) return "Archived";
  if (activation >= threshold) return "Active";
  return "Dormant";
}

// ── Generic DMAE Manager ──
// 把 updateActivation / getActiveEntries / state 管理抽象出来，Worldbook 与 L2 共用同一引擎。
export interface DmaeManagerOptions<T extends DmaeEntry = DmaeEntry> {
  params?: Partial<DmaeParams>;
  rewardStrategy?: RewardStrategy<T>;
  decayStrategy?: DecayStrategy<T>;
  debug?: boolean;
}

export class DmaeManager<T extends DmaeEntry> {
  private state = new Map<string, EntryState>();
  private params: DmaeParams;
  private rewardStrategy: RewardStrategy<T>;
  private decayStrategy: DecayStrategy<T>;
  private debug: boolean;

  constructor(options?: DmaeManagerOptions<T>) {
    this.params = { ...DEFAULT_DMAE_PARAMS, ...(options?.params ?? {}) };
    this.rewardStrategy = options?.rewardStrategy ?? new DefaultRewardStrategy<T>();
    this.decayStrategy = options?.decayStrategy ?? new QuadraticResistanceDecay<T>();
    this.debug = options?.debug ?? true;
  }

  getParams(): DmaeParams {
    return this.params;
  }

  getDebug(): boolean {
    return this.debug;
  }

  // 初始化/重置一条 entry 的状态（加载 entries 时调用）
  initEntry(id: string): void {
    this.state.set(id, { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] });
  }

  removeEntry(id: string): void {
    this.state.delete(id);
  }

  clear(): void {
    this.state.clear();
  }

  // 批量注册 entries（例如加载 worldbook / L2 列表）
  initEntries(entries: readonly T[]): void {
    this.state.clear();
    for (const e of entries) {
      if (e.enabled && !e.permanent) {
        this.state.set(e.id, { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] });
      }
    }
  }

  getState(id: string): EntryState | undefined {
    return this.state.get(id);
  }

  setState(id: string, st: EntryState): void {
    this.state.set(id, st);
  }

  // V5.1 DMAE 主循环
  updateActivation(entries: readonly T[], userText: string, modelText: string, turn = 0): Set<string> {
    const user = userText ?? "";
    const model = modelText ?? "";
    const params = this.params;
    const max = params.maxScore;
    const threshold = params.promptThreshold;
    const changed: Array<{ id: string; aOld: number; aNew: number; reason: string }> = [];
    const userHitIds = new Set<string>();

    for (const entry of entries) {
      if (!entry.enabled || entry.permanent) continue;
      if (entry.keywords.length === 0) continue;

      const userHit = entry.keywords.some((kw) => user.includes(kw));
      const modelHit = entry.keywords.some((kw) => model.includes(kw));
      if (userHit) userHitIds.add(entry.id);

      const st = this.state.get(entry.id);
      if (!st) continue;

      const aOld = st.activation;
      const usOld = st.userSilence;
      const msOld = st.modelSilence;
      const oldState = deriveState(aOld, threshold);

      // V5.1：未命中的 Archived 条目跳过本轮计算
      if (oldState === WORLDBOOK_CONSTANTS.STATES.ARCHIVED && !userHit && !modelHit) {
        continue;
      }

      // Lifecycle Phase：Wake-Up（V5 §7.4）
      let aInit = aOld;
      let wokeUp = false;
      if (userHit && oldState === WORLDBOOK_CONSTANTS.FLOOR_TRIGGER_STATE) {
        aInit = Math.min(max, threshold + params.wakeBonus);
        wokeUp = true;
      }

      // silence update
      const usNew = userHit ? 0 : usOld + 1;
      const msNew = (userHit || modelHit) ? 0 : msOld + 1;

      // V5.5：维护 recentUserHits 窗口
      let recentHits = st.recentUserHits;
      if (userHit) {
        recentHits = [...recentHits, turn].filter((t) => t > turn - params.repeatWindow);
      } else {
        recentHits = recentHits.filter((t) => t > turn - params.repeatWindow);
      }
      const recentHitCount = recentHits.length;

      // reward
      const snap = { activation: aInit, userSilence: usOld, modelSilence: msOld };
      const userReward = userHit
        ? this.rewardStrategy.userReward({ entry, snap, params, recentHitCount })
        : 0;

      // decay
      const decay = this.decayStrategy.compute({
        entry,
        snap: { userSilence: usNew, modelSilence: msNew },
        params,
      });

      // model reward
      let modelReward = 0;
      if (modelHit && oldState === WORLDBOOK_CONSTANTS.STATES.ACTIVE) {
        const rawRm = this.rewardStrategy.modelReward({ entry, snap: { activation: aOld, userSilence: usOld, modelSilence: msOld }, params, recentHitCount });
        modelReward = Math.max(0, Math.min(rawRm, decay - WORLDBOOK_CONSTANTS.EPSILON));
      }

      // commit
      let aNew = aInit + userReward + modelReward - decay;
      aNew = Math.max(0, Math.min(max, aNew));

      st.activation = aNew;
      st.userSilence = usNew;
      st.modelSilence = msNew;
      st.recentUserHits = recentHits;

      if (this.debug && (userHit || modelHit || wokeUp || Math.abs(aNew - aOld) >= 0.05)) {
        const reasons: string[] = [];
        if (wokeUp) reasons.push(`wake→${aInit.toFixed(1)}`);
        if (userHit) reasons.push(`U+${userReward.toFixed(2)}`);
        if (modelHit) reasons.push(`M+${modelReward.toFixed(2)}`);
        if (decay > 0) reasons.push(`D-${decay.toFixed(2)}`);
        changed.push({ id: entry.id, aOld, aNew, reason: reasons.join(" ") });
      }
    }

    if (this.debug && changed.length > 0) {
      console.log(`[DMAE] update: ${changed.length} entries changed`);
      for (const c of changed.slice(0, 12)) {
        console.log(`  ${c.id}: ${c.aOld.toFixed(1)} → ${c.aNew.toFixed(1)}  (${c.reason})`);
      }
    }

    return userHitIds;
  }

  // 返回 Activation >= threshold 的条目，按 activation 降序、priority 不作为 tiebreaker（通用层无 priority 概念）
  getActiveEntries(entries: readonly T[], threshold?: number): T[] {
    const th = threshold ?? this.params.promptThreshold;
    return entries.filter((e) => {
      if (!e.enabled || e.permanent) return false;
      const st = this.state.get(e.id);
      if (!st) return false;
      return deriveState(st.activation, th) === WORLDBOOK_CONSTANTS.STATES.ACTIVE;
    }).sort((a, b) => {
      const sa = this.state.get(a.id)!.activation;
      const sb = this.state.get(b.id)!.activation;
      return sb - sa;
    });
  }
}

// ── Worldbook Manager ──
export interface WorldbookManagerOptions {
  params?: Partial<DmaeParams>;
  rewardStrategy?: RewardStrategy<WorldbookEntry>;
  decayStrategy?: DecayStrategy<WorldbookEntry>;
  stateFile?: string;   // v1 持久化 seam：传了也暂时只 load/save 空实现，重启回 0
  debug?: boolean;
}

export class WorldbookManager {
  private entries: WorldbookEntry[] = [];
  private worldbookDir: string;
  private dmae: DmaeManager<WorldbookEntry>;
  // ── One-Shot cascade：本轮用户命中后连带触发的条目（不入 DMAE 状态表，只本轮有效）──
  private lastCascadeEntries: WorldbookEntry[] = [];
  private stateFile?: string;

  // 终态注入上限（详见 worldbook-constants.ts）
  private static readonly MAX_ACTIVE = WORLDBOOK_CONSTANTS.MAX_ACTIVE;

  // .md 未写 intrinsic value 时的 fallback（详见 worldbook-constants.ts）
  private static readonly DEFAULT_INTRINSIC_VALUE = WORLDBOOK_CONSTANTS.DEFAULT_INTRINSIC_VALUE;

  constructor(worldbookDir: string, options?: WorldbookManagerOptions) {
    this.worldbookDir = worldbookDir;
    this.dmae = new DmaeManager<WorldbookEntry>({
      params: options?.params,
      rewardStrategy: options?.rewardStrategy,
      decayStrategy: options?.decayStrategy,
      debug: options?.debug,
    });
    this.stateFile = options?.stateFile;
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

    // 初始化 DMAE 状态：每条非常驻条目 activation=0（Archived 冷态）
    // 常驻条目不进 DMAE（始终注入），不给它们分配状态。
    this.dmae.initEntries(this.entries);

    // v1 持久化 seam：预留，暂为空（重启回 0）
    this.loadState();

    const nonPermanent = this.entries.filter((e) => e.enabled && !e.permanent).length;
    logger.info(LogTag.Worldbook, `loaded ${allEntries.length} entries from ${files.length} files; DMAE state initialized for ${nonPermanent} non-permanent entries`);
  }

  // 从内存 entries 加载（不读 fs）：simulator / 测试用。
  // 复用 loadFromDirectory 的状态初始化逻辑，保证 sim 和生产用同一套初始化路径。
  loadFromEntries(entries: WorldbookEntry[]): void {
    this.entries = entries;
    this.dmae.initEntries(this.entries);
    this.loadState();
  }

  // Parse markdown format:
  // ## 条目名
  // - 触发词: 词1, 词2, 词3
  // - 常驻: 是
  // - 优先级: 200
  // - 内在价值: 60                ← v3.4 新名（与 初始分/initial_score/intrinsic_value 兼容）
  //
  // 内容段落...
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

        if (metaLine.startsWith("- 触发词:") || metaLine.startsWith("- 触发词：")) {
          const val = metaLine.replace(/^-\s*触发词[：:]/, "").trim();
          keywords = val.split(/[,，、]/).map((k) => k.trim()).filter(Boolean);
          i++;
        } else if (metaLine.startsWith("- 常驻:")) {
          const val = metaLine.replace(/^-\s*常驻:/, "").trim();
          permanent = val === "是" || val === "yes" || val === "true";
          i++;
        } else if (metaLine.startsWith("- 优先级:")) {
          const val = metaLine.replace(/^-\s*优先级:/, "").trim();
          priority = parseInt(val) || 5;
          i++;
        } else if (
          metaLine.startsWith("- 初始分:") || metaLine.startsWith("- 初始分：") ||
          metaLine.startsWith("- initial_score:") || metaLine.startsWith("- initial_score：") ||
          metaLine.startsWith("- 内在价值:") || metaLine.startsWith("- 内在价值：") ||
          metaLine.startsWith("- intrinsic_value:") || metaLine.startsWith("- intrinsic_value：")
        ) {
          const val = metaLine.replace(/^-\s*(初始分|initial_score|内在价值|intrinsic_value)[：:]/, "").trim();
          const parsed = parseFloat(val);
          intrinsicValue = Number.isFinite(parsed) ? parsed : WorldbookManager.DEFAULT_INTRINSIC_VALUE;
          i++;
        } else if (metaLine.startsWith("- 连带触发词:") || metaLine.startsWith("- 连带触发词：") ||
                   metaLine.startsWith("- 连带触发:") || metaLine.startsWith("- 连带触发：") ||
                   metaLine.startsWith("- link_triggers:") || metaLine.startsWith("- link_triggers：")) {
          const val = metaLine.replace(/^-\s*(连带触发词|连带触发|link_triggers)[：:]/, "").trim();
          // "无" / "无" / "" 表示不连带
          if (val && val !== "无" && val !== "无" && val !== "none" && val !== "-") {
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

  // ── DMAE 打分层：委托给通用 DmaeManager，然后追加 One-Shot cascade ──
  updateActivation(userText: string, modelText: string, turn = 0): void {
    const userHitEntryIds = this.dmae.updateActivation(this.entries, userText, modelText, turn);

    // ── One-Shot 联动触发（不入 DMAE 状态表，只本轮有效）──
    // 规则：只有 userHit 的条目才有连带触发权；cascade 目标不再级联（1 层封顶）。
    // 防死循环 3 条硬约束：
    //   1. 1 层封顶：cascade 只从 userHit 触发，cascade 目标不会再 cascade
    //   2. userHit 拦截：cascade 目标已在 userHit 列表则跳过（已被主动激活）
    //   3. cascade 集合去重：同条目本轮只 cascade 一次
    this.lastCascadeEntries = [];
    const cascadeInjected = new Set<string>();
    for (const entry of this.entries) {
      if (!userHitEntryIds.has(entry.id)) continue;
      if (entry.linkTriggers.length === 0) continue;
      if (entry.permanent || !entry.enabled) continue;

      // 找 linkTriggers 对应的子条目（关键词命中）
      const targets = this.entries.filter(e =>
        e.enabled && !e.permanent &&
        e.keywords.some(kw => entry.linkTriggers.includes(kw))
      );

      for (const target of targets) {
        // 硬约束 2：跳过 userHit
        if (userHitEntryIds.has(target.id)) continue;
        // 硬约束 3：cascade 去重
        if (cascadeInjected.has(target.id)) continue;

        cascadeInjected.add(target.id);
        this.lastCascadeEntries.push(target);
      }
    }

    if (this.dmae.getDebug() && this.lastCascadeEntries.length > 0) {
      console.log(`[Worldbook/Cascade] ${this.lastCascadeEntries.length} entries one-shot injected: ${this.lastCascadeEntries.map(e => e.id).join(", ")}`);
    }
  }

  // 取本轮 One-Shot cascade 触发的条目（仅供 orchestrator 注入用，不进 DMAE 状态表）
  getCascadeEntries(): WorldbookEntry[] {
    return [...this.lastCascadeEntries];
  }

  // ── 业务层：阈值门控 + 注入 ──
  // deriveState(activation, promptThreshold)=="Active" 的条目注入；按 activation 降序、priority 降序 tiebreak、截 MAX_ACTIVE。
  getActiveEntries(promptThreshold?: number): string[] {
    const params = this.dmae.getParams();
    const th = promptThreshold ?? params.promptThreshold;
    let active = this.dmae.getActiveEntries(this.entries, th) as WorldbookEntry[];
    // 通用层只按 activation 排序；worldbook 追加 priority tiebreak
    active = active.sort((a, b) => {
      const sa = this.dmae.getState(a.id)!.activation;
      const sb = this.dmae.getState(b.id)!.activation;
      if (sb !== sa) return sb - sa;
      return b.priority - a.priority;
    }).slice(0, WorldbookManager.MAX_ACTIVE);

    if (this.dmae.getDebug() && active.length > 0) {
      console.log(`[Worldbook/DMAE] active entries injected: ${active.length} (threshold=${th})`);
    }
    // 返回带条目标题的完整内容（模型需要知道这段设定在说谁）
    return active.map((e) => {
      // 从 entry.id 还原可读标题：wb_<file>_<title> → <title>
      const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
      return `【${title}】\n${e.content}`;
    });
  }

  // Get permanent entries (常驻) — always included, bypass DMAE
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

  // ── 只读访问器（simulator / 调试用）──
  getEntries(): readonly WorldbookEntry[] {
    return this.entries;
  }

  getState(id: string): EntryState | undefined {
    return this.dmae.getState(id);
  }

  // ── 持久化 seam（v1 no-op；后续接 JsonVectorStore 同款 sync JSON）──
  private loadState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: fs.readFileSync(this.stateFile) → 反序列化到 this.dmae
    // 暂不落盘，重启回 0（已确认 v1 接受）
  }

  private saveState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: fs.writeFileSync(this.stateFile, JSON.stringify([...this.dmae]))
  }
}
