import * as fs from "fs";
import * as path from "path";

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

// ── DMAE runtime state (per entry, keyed by entry.id) ──
// 注意：state 不挂 WorldbookEntry 上——loadFromDirectory 会整表替换 this.entries，
// 挂上面会在重载时丢失。这里独立维护一张状态表。
export interface EntryState {
  activation: number;     // 0..MaxScore
  userSilence: number;    // 距上次用户命中的轮数
  modelSilence: number;   // 距上次模型命中的轮数
  // 无 state 字段——由 (activation, threshold) 派生（业务层负责，updateActivation 不碰阈值）
}

export type DmaeState = "Active" | "Dormant" | "Archived";

// ── DMAE 可调参数（v3.4 收口版）──
// 任何参数都只是默认值，不是结论。所有参数以后都通过 Simulator 调整。
export interface DmaeParams {
  maxScore: number;             // 100：物理上界
  promptThreshold: number;      // 30：>= 此值进 Prompt（业务层用）
  wakeBaseRate: number;         // 0.1：WakeCurve 命中基数
  wakeK: number;                // 8：WakeCurve 斜率
  efficiencyFloor: number;      // 0.05：Efficiency 下限
  rewardGain: number;           // 5：Reward 倍率（默认值；Simulator 跑 3/5/7/10 选最优）
  decayAlpha: number;           // 1.0：Quadratic US 系数
  decayBeta: number;            // 0.3：Quadratic MS 系数
}

export const DEFAULT_DMAE_PARAMS: DmaeParams = {
  maxScore: 100,
  promptThreshold: 30,
  wakeBaseRate: 0.1,
  wakeK: 8,
  efficiencyFloor: 0.05,
  rewardGain: 5,
  decayAlpha: 5.0,    // 用户目标：I=60 顶多 6 轮归零；高 I 自然多赖 1-2 轮
  decayBeta: 0.5,
};

// ── 策略接口（v3.4 框架固化，以后不再改）──
export interface RewardContext {
  entry: WorldbookEntry;
  snap: { activation: number; userSilence: number; modelSilence: number };
  userHit: boolean;
  params: DmaeParams;
}
export interface DecayContext {
  entry: WorldbookEntry;
  snap: { userSilence: number; modelSilence: number };  // 更新后值
  params: DmaeParams;
}

export interface RewardStrategy {
  // v3.4：modelHit 不入参、不给分（模型没有兴趣表达权 §7.3/§7.4）
  compute(ctx: RewardContext): number;
}

export interface DecayStrategy {
  compute(ctx: DecayContext): number;
}

// ── v3.4 默认 Reward 策略 ──
// Reward = rewardGain × WakeCurve(US_old) × Efficiency(A_old)
//   - WakeCurve(US) = baseRate + (1-baseRate) · US/(US+K)        [0~1, US=0 时给 baseRate]
//   - Efficiency(A) = max(efficiencyFloor, 1 - A/MaxScore)       [0.05~1, A=Max 时给 floor]
// I 不参与（避免高价值条目既涨得快又忘得慢而天然霸榜）。
export class DefaultRewardStrategy implements RewardStrategy {
  compute(ctx: RewardContext): number {
    if (!ctx.userHit) return 0;
    const { snap, params } = ctx;
    const wake = params.wakeBaseRate
      + (1 - params.wakeBaseRate) * snap.userSilence / (snap.userSilence + params.wakeK);
    const eff = Math.max(params.efficiencyFloor, 1 - snap.activation / params.maxScore);
    return params.rewardGain * wake * eff;
  }
}

// ── v3.4 默认 Decay 策略 ──
// Decay = (α·US² + β·MS²) / sqrt(I)   [I 仅在 Resistance：高 I = 抵抗强 = 忘得慢]
// 平方 → 累计加速遗忘 §8.1；除以 sqrt(I) → "价值决定忘得多慢，而不是爱得多深"。
export class QuadraticResistanceDecay implements DecayStrategy {
  compute(ctx: DecayContext): number {
    const { entry, snap, params } = ctx;
    const I = Math.max(1, entry.intrinsicValue);
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

// ── Worldbook Manager ──
export interface WorldbookManagerOptions {
  params?: Partial<DmaeParams>;
  rewardStrategy?: RewardStrategy;
  decayStrategy?: DecayStrategy;
  stateFile?: string;   // v1 持久化 seam：传了也暂时只 load/save 空实现，重启回 0
  debug?: boolean;
}

export class WorldbookManager {
  private entries: WorldbookEntry[] = [];
  private worldbookDir: string;
  private state = new Map<string, EntryState>();
  // ── One-Shot cascade：本轮用户命中后连带触发的条目（不入 DMAE 状态表，只本轮有效）──
  private lastCascadeEntries: WorldbookEntry[] = [];
  private params: DmaeParams;
  private rewardStrategy: RewardStrategy;
  private decayStrategy: DecayStrategy;
  private stateFile?: string;
  private debug: boolean;

  // 终态注入上限（Scheduler 层硬上限；未来 v4 换 token-budget 背包）
  private static readonly MAX_ACTIVE = 8;

  // 解析器：.md 未写 intrinsic value 时的缺省（v3.3 是从 DmaeParams 拿，v3.4 提到这里）
  private static readonly DEFAULT_INTRINSIC_VALUE = 60;

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

    // 初始化 DMAE 状态：每条非常驻条目 activation=0（Archived 冷态）
    // 常驻条目不进 DMAE（始终注入），不给它们分配状态。
    this.state.clear();
    for (const e of this.entries) {
      if (e.enabled && !e.permanent) {
        this.state.set(e.id, { activation: 0, userSilence: 0, modelSilence: 0 });
      }
    }

    // v1 持久化 seam：预留，暂为空（重启回 0）
    this.loadState();

    console.log(`[Worldbook] loaded ${allEntries.length} entries from ${files.length} files; DMAE state initialized for ${this.state.size} non-permanent entries`);
  }

  // 从内存 entries 加载（不读 fs）：simulator / 测试用。
  // 复用 loadFromDirectory 的状态初始化逻辑，保证 sim 和生产用同一套初始化路径。
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

  // ── DMAE 打分层：每轮更新所有条目的 Activation/US/MS ──
  // v3.4 收口公式：
  //   reward = userHit ? rewardGain × Wake(US_old) × Eff(A_old) : 0   (I 不参与 Reward)
  //   decay  = (α·US_new² + β·MS_new²) / sqrt(I)                       (I 仅在 Resistance)
  //   A_new  = clamp(A_old + reward - decay, 0, MaxScore)
  //   if userHit && A_old 状态 == Archived: A_new = max(A_new, I)      (★ 仅 Archived 复活时 floor；I 参与 Floor 基线)
  // MS 语义：距离最近一次"进入上下文"的轮数（userHit 或 modelHit 都重置），不是"模型有没有说过"
  // ModelHit：只重置 msNew = 0，不给任何 reward（模型没有兴趣表达权 §7.3/§7.4）
  // Snapshot 语义：每条 entry 独立、先读旧值再统一写，互不影响（DMAE §4/§11.1）。
  updateActivation(userText: string, modelText: string): void {
    const user = userText ?? "";
    const model = modelText ?? "";
    const params = this.params;
    const max = params.maxScore;
    const changed: Array<{ id: string; aOld: number; aNew: number; reason: string }> = [];

    // ── 第一遍：收集本轮所有 userHit 条目 id（cascade 通道用，DMAE 主循环也要）──
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
      // MS = 距离最近一次"进入上下文"的轮数。用户主动提 OR 模型自然提都属于"进入上下文"，
      // 所以 userHit 也重置 ms——否则用户连续提但模型不复述时 ms 累积导致 decay 上升、A 反而下降。
      const msNew = (userHit || modelHit) ? 0 : msOld + 1;

      // ─ positive: reward（仅 userHit，I 不参与） ─
      const reward = userHit
        ? this.rewardStrategy.compute({ entry, snap: { activation: aOld, userSilence: usOld, modelSilence: msOld }, userHit: true, params })
        : 0;

      // ─ negative: decay（I 仅在 Resistance） ─
      const decay = this.decayStrategy.compute({
        entry,
        snap: { userSilence: usNew, modelSilence: msNew },
        params,
      });

      // ─ commit ─
      let aNew = aOld + reward - decay;
      aNew = Math.max(0, aNew);
      // ★ Floor 仅在 Archived 复活时触发（避免高价值条目每次命中都 floor 让 Decay/Wake 失效）
      if (userHit && deriveState(aOld, params.promptThreshold) === "Archived") {
        aNew = Math.max(aNew, entry.intrinsicValue);
      }
      aNew = Math.min(max, aNew);

      st.activation = aNew;
      st.userSilence = usNew;
      st.modelSilence = msNew;

      if (this.debug && (userHit || modelHit || Math.abs(aNew - aOld) >= 0.05)) {
        const reasons: string[] = [];
        if (userHit) reasons.push(`U+${reward.toFixed(2)}`);
        if (modelHit) reasons.push(`[M]`);
        if (decay > 0) reasons.push(`D-${decay.toFixed(2)}`);
        if (userHit && deriveState(aOld, params.promptThreshold) === "Archived") reasons.push(`floor→${entry.intrinsicValue}`);
        changed.push({ id: entry.id, aOld, aNew, reason: reasons.join(" ") });
      }
    }

    if (this.debug && changed.length > 0) {
      console.log(`[Worldbook/DMAE] update: ${changed.length} entries changed`);
      for (const c of changed.slice(0, 12)) {
        console.log(`  ${c.id}: ${c.aOld.toFixed(1)} → ${c.aNew.toFixed(1)}  (${c.reason})`);
      }
    }

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

    if (this.debug && this.lastCascadeEntries.length > 0) {
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
    const th = promptThreshold ?? this.params.promptThreshold;
    const active = this.entries
      .filter((e) => {
        if (!e.enabled || e.permanent) return false;
        const st = this.state.get(e.id);
        if (!st) return false;
        return deriveState(st.activation, th) === "Active";
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
    return this.state.get(id);
  }

  // ── 持久化 seam（v1 no-op；后续接 JsonVectorStore 同款 sync JSON）──
  private loadState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: fs.readFileSync(this.stateFile) → 反序列化到 this.state
    // 暂不落盘，重启回 0（已确认 v1 接受）
  }

  private saveState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: fs.writeFileSync(this.stateFile, JSON.stringify([...this.state]))
  }
}
