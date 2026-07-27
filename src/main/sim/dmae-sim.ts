// ── DMAE Simulator 入口 ──
// 直接 import 真 worldbook.ts，不 mock，不重寫算法。
// 改一個參數 → 重跑 → 看曲線/統計 → 改回/保留
import * as path from "path";
import {
  WorldbookManager,
  deriveState,
  DEFAULT_DMAE_PARAMS,
  type DmaeParams,
  type EntryState,
} from "../rag/worldbook";
import { coffeeLifecycle } from "./scenarios/coffee-lifecycle";
import { fourTierMix } from "./scenarios/four-tier-mix";
import { dormantRescue } from "./scenarios/dormant-rescue";
import type { Scenario, Round, SimResult, EntrySnapshot, SimStats } from "./sim-types";
import { computeStats, printStats } from "./render/stats";
import { exportCsv } from "./render/csv-export";
import { renderLineCharts } from "./render/ascii-line-chart";
import { renderBars } from "./render/ascii-bars";

interface CliArgs {
  scenario: "coffee" | "mix" | "rescue";
  paramOverrides: Partial<DmaeParams>;
  rewardGainSweep: number[] | null;
  outputDir: string;
  showCharts: boolean;
  showBars: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    scenario: "coffee",
    paramOverrides: {},
    rewardGainSweep: null,
    outputDir: path.join(process.cwd(), "sim-result", "v3.4"),
    showCharts: true,
    showBars: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // 兼容 --key=value 和 --key value 兩種形態
    const eq = a.includes("=");
    const key = eq ? a.split("=")[0] : a;
    const valFromEq = eq ? a.split("=").slice(1).join("=") : null;
    const next = () => argv[++i];
    const v = () => valFromEq ?? next();

    if (key === "--scenario") args.scenario = v() as "coffee" | "mix" | "rescue";
    else if (key === "--userRewardBase") {
      const x = v();
      if (x.includes(",")) {
        args.rewardGainSweep = x.split(",").map(Number).filter(Number.isFinite);
      } else {
        args.paramOverrides.userRewardBase = Number(x);
      }
    }
    else if (key === "--wakeGamma") args.paramOverrides.wakeGamma = Number(v());
    else if (key === "--modelRewardBase") args.paramOverrides.modelRewardBase = Number(v());
    else if (key === "--wakeLambda") args.paramOverrides.wakeLambda = Number(v());
    else if (key === "--alpha") args.paramOverrides.decayAlpha = Number(v());
    else if (key === "--beta") args.paramOverrides.decayBeta = Number(v());
    else if (key === "--threshold") args.paramOverrides.promptThreshold = Number(v());
    else if (key === "--outputDir") args.outputDir = v();
    else if (key === "--no-charts") args.showCharts = false;
    else if (key === "--no-bars") args.showBars = false;
  }
  return args;
}

function getScenario(name: string): Scenario {
  if (name === "coffee") return coffeeLifecycle;
  if (name === "mix") return fourTierMix;
  if (name === "rescue") return dormantRescue;
  throw new Error(`Unknown scenario: ${name}`);
}

function runScenario(
  scenario: Scenario,
  params: DmaeParams,
  debug: boolean = false
): SimResult {
  // 直接用真 WorldbookManager：通過公開的 loadFromEntries 注入 entries（不反射、不破壞封裝）
  const mgr = new WorldbookManager("", { params, debug: false });
  mgr.loadFromEntries(scenario.buildEntries());

  const rounds = scenario.buildRounds();
  const entries = mgr.getEntries();
  const snapshots: EntrySnapshot[][] = [];

  for (const round of rounds) {
    // 跑一整輪：manager.updateActivation(userText, modelText)
    mgr.updateActivation(round.userText, round.modelText);
    // 拍快照
    const snap: EntrySnapshot[] = entries.map((e) => {
      const st: EntryState | undefined = mgr.getState(e.id);
      const a = st?.activation ?? 0;
      const us = st?.userSilence ?? 0;
      const ms = st?.modelSilence ?? 0;
      return {
        entryId: e.id,
        intrinsicValue: e.intrinsicValue,
        priority: e.priority,
        activation: a,
        userSilence: us,
        modelSilence: ms,
        state: deriveState(a, params.promptThreshold),
        userHit: e.keywords.some((kw: string) => round.userText.includes(kw)),
        modelHit: e.keywords.some((kw: string) => round.modelText.includes(kw)),
      };
    });
    snapshots.push(snap);
  }

  const result: SimResult = {
    scenario: scenario.name,
    params,
    entries: [...entries],
    rounds,
    snapshots,
    stats: { promptOccupancy: new Map(), avgActiveLife: new Map(), promptRanking: new Map(), totalRounds: rounds.length },
  };
  result.stats = computeStats(result);
  return result;
}

function runSweep(scenario: Scenario, baseParams: DmaeParams, values: number[]): void {
  console.log(`\n=== Parameter Sweep: userRewardBase = [${values.join(", ")}] on ${scenario.name} ===\n`);
  console.log("Bu       |  I=90 佔用%  |  I=70 佔用%  |  I=45 佔用%  |  I=15 佔用%  |  avgLife(I=45)");
  console.log("---------|---------------|---------------|---------------|---------------|---------------");
  for (const v of values) {
    const params: DmaeParams = { ...baseParams, userRewardBase: v };
    const result = runScenario(scenario, params, false);
    const tiers = [90, 70, 45, 15];
    const occByI: string[] = [];
    for (const I of tiers) {
      const ent = result.entries.find((e) => Math.abs(e.intrinsicValue - I) < 1 && !e.permanent);
      const occ = ent ? (result.stats.promptOccupancy.get(ent.id) ?? 0) * 100 : 0;
      occByI.push(occ.toFixed(1).padStart(5));
    }
    const midEnt = result.entries.find((e) => Math.abs(e.intrinsicValue - 45) < 1 && !e.permanent);
    const midLife = midEnt ? (result.stats.avgActiveLife.get(midEnt.id) ?? 0).toFixed(2) : "-";
    console.log(`${String(v).padStart(7)}  |  ${occByI[0]}        |  ${occByI[1]}        |  ${occByI[2]}        |  ${occByI[3]}        |  ${midLife}`);
  }
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const scenario = getScenario(cli.scenario);

  console.log(`\n========================================`);
  console.log(`  DMAE v3.4 Simulator`);
  console.log(`  Scenario: ${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(`========================================`);

  if (cli.rewardGainSweep) {
    runSweep(scenario, { ...DEFAULT_DMAE_PARAMS, ...cli.paramOverrides }, cli.rewardGainSweep);
    return;
  }

  const params: DmaeParams = { ...DEFAULT_DMAE_PARAMS, ...cli.paramOverrides };
  console.log(`參數: ${JSON.stringify(params, null, 2)}`);

  const result = runScenario(scenario, params, true);

  // CSV
  const csvFile = exportCsv(result, cli.outputDir);
  console.log(`\nCSV 寫入: ${csvFile}`);

  // 統計
  printStats(result);

  // 折線圖
  if (cli.showCharts) renderLineCharts(result);
  // 條形圖
  if (cli.showBars) renderBars(result);
}

main();
