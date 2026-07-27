// 3 類統計：Prompt 佔用率 / 平均壽命 / 每輪 Prompt 排名
import type { SimResult, SimStats, EntrySnapshot } from "../sim-types";
import { deriveState } from "../../rag/worldbook";

export function computeStats(result: SimResult): SimStats {
  const threshold = result.params.promptThreshold;
  const occupancy = new Map<string, number>();
  const life = new Map<string, number[]>();
  const ranking = new Map<number, string[]>();

  for (const entry of result.entries) {
    occupancy.set(entry.id, 0);
    life.set(entry.id, []);
  }

  // 佔用率 + 排名（ranking 只含 A>0 的條目，避免把一堆 Archived 死條目當"Prompt 排名"）
  for (let r = 0; r < result.snapshots.length; r++) {
    const sorted = [...result.snapshots[r]]
      .filter((s) => {
        const ent = result.entries.find((e) => e.id === s.entryId);
        return ent && !ent.permanent && s.activation > 0;
      })
      .sort((a, b) => b.activation - a.activation)
      .map((s) => s.entryId);
    ranking.set(r, sorted);
    for (const snap of result.snapshots[r]) {
      if (snap.state === "Active") {
        occupancy.set(snap.entryId, (occupancy.get(snap.entryId) ?? 0) + 1);
      }
    }
  }

  // 佔用率歸一化
  const totalRounds = result.snapshots.length;
  for (const [k, v] of occupancy) {
    occupancy.set(k, totalRounds > 0 ? v / totalRounds : 0);
  }

  // 平均壽命：連續 Active 段的平均長度
  for (const entry of result.entries) {
    const snaps = result.snapshots.map((s) => s.find((x) => x.entryId === entry.id)).filter(Boolean) as EntrySnapshot[];
    let curRun = 0;
    for (const s of snaps) {
      if (s.state === "Active") {
        curRun++;
      } else if (curRun > 0) {
        life.get(entry.id)!.push(curRun);
        curRun = 0;
      }
    }
    if (curRun > 0) life.get(entry.id)!.push(curRun);
  }

  const avgLife = new Map<string, number>();
  for (const [k, runs] of life) {
    avgLife.set(k, runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 0);
  }

  return { promptOccupancy: occupancy, avgActiveLife: avgLife, promptRanking: ranking, totalRounds };
}

export function printStats(result: SimResult): void {
  const { stats, entries, params } = result;
  console.log("\n=== 3 類統計 ===");
  console.log(`參數: Bu=${params.userRewardBase} γ=${params.wakeGamma} Bm=${params.modelRewardBase} λ=${params.wakeLambda} α=${params.decayAlpha} β=${params.decayBeta} threshold=${params.promptThreshold}`);
  console.log(`總輪數: ${stats.totalRounds}\n`);

  console.log("--- Prompt 佔用率（多少輪處於 Active）---");
  const occRows = entries
    .filter((e) => !e.permanent)
    .map((e) => {
      const occ = stats.promptOccupancy.get(e.id) ?? 0;
      return { id: e.id, I: e.intrinsicValue, occ };
    })
    .sort((a, b) => b.occ - a.occ);
  for (const r of occRows) {
    const bar = "█".repeat(Math.round(r.occ * 40));
    console.log(`  ${r.id.padEnd(40)}  I=${String(r.I).padStart(3)}  ${(r.occ * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }

  console.log("\n--- 平均壽命（一次激活平均持續輪數）---");
  const lifeRows = entries
    .filter((e) => !e.permanent)
    .map((e) => ({ id: e.id, I: e.intrinsicValue, life: stats.avgActiveLife.get(e.id) ?? 0 }))
    .sort((a, b) => b.life - a.life);
  for (const r of lifeRows) {
    console.log(`  ${r.id.padEnd(40)}  I=${String(r.I).padStart(3)}  ${r.life.toFixed(2).padStart(6)} 輪/次`);
  }

  console.log("\n--- 每輪 Prompt 排名（每 5 輪抽樣）---");
  const step = Math.max(1, Math.floor(stats.totalRounds / 20));
  for (let r = 0; r < stats.totalRounds; r += step) {
    const top = (stats.promptRanking.get(r) ?? []).slice(0, 5);
    if (top.length === 0) continue;
    console.log(`  R${String(r).padStart(3)}: ${top.map((id, i) => `${i + 1}.${id.split("_").slice(-2).join("_")}`).join("  ")}`);
  }
}
