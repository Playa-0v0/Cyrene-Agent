// ASCII 折线图：每条目一张，X=轮 Y=A，标状态切换
import type { SimResult } from "../sim-types";

const CHART_WIDTH = 60;
const CHART_HEIGHT = 12;

export function renderLineCharts(result: SimResult): void {
  console.log("\n=== ASCII 折线图（每条目一张）===");
  const yMax = result.params.maxScore;
  const threshold = result.params.promptThreshold;
  for (const entry of result.entries) {
    if (entry.permanent) {
      console.log(`\n[permanent] ${entry.id} (常驻旁路，不进 DMAE)`);
      continue;
    }
    const series: Array<{ round: number; a: number; state: string }> = [];
    for (let r = 0; r < result.snapshots.length; r++) {
      const snap = result.snapshots[r].find((s) => s.entryId === entry.id);
      if (snap) series.push({ round: r, a: snap.activation, state: snap.state });
    }
    drawChart(entry.id, entry.intrinsicValue, series, result.snapshots.length, yMax, threshold);
  }
}

function drawChart(
  title: string,
  intrinsicValue: number,
  series: Array<{ round: number; a: number; state: string }>,
  totalRounds: number,
  yMax: number,
  threshold: number,
): void {
  console.log(`\n${title}  (I=${intrinsicValue})`);
  if (series.length === 0) {
    console.log("  (no data)");
    return;
  }
  const grid: string[][] = Array.from({ length: CHART_HEIGHT }, () => Array(CHART_WIDTH).fill(" "));
  // 画 threshold / intrinsicValue 两条水平参考线（从 params 读，不写死）
  for (let x = 0; x < CHART_WIDTH; x++) {
    const yT = Math.round((1 - threshold / yMax) * (CHART_HEIGHT - 1));
    const yI = Math.round((1 - intrinsicValue / yMax) * (CHART_HEIGHT - 1));
    if (yT >= 0 && yT < CHART_HEIGHT) grid[yT][x] = (x % 5 === 0) ? ":" : "·";
    if (yI >= 0 && yI < CHART_HEIGHT) grid[yI][x] = (x % 5 === 0) ? "-" : "·";
  }
  // 画数据点
  for (const s of series) {
    const x = Math.round((s.round / Math.max(1, totalRounds - 1)) * (CHART_WIDTH - 1));
    const y = Math.round((1 - s.a / yMax) * (CHART_HEIGHT - 1));
    if (y >= 0 && y < CHART_HEIGHT && x >= 0 && x < CHART_WIDTH) {
      grid[y][x] = s.state === "Active" ? "█" : s.state === "Dormant" ? "▒" : "·";
    }
  }
  // 输出（Y 轴标注）
  for (let row = 0; row < CHART_HEIGHT; row++) {
    const labelVal = Math.round((1 - row / (CHART_HEIGHT - 1)) * yMax);
    const label = String(labelVal).padStart(3);
    console.log(`${label} |${grid[row].join("")}|`);
  }
  console.log(`    0${"-".repeat(CHART_WIDTH)}${totalRounds - 1}`);
  console.log(`    [█=Active  ▒=Dormant  ·=Archived  :·=threshold(${threshold})  -·=I值(${intrinsicValue})]`);
}
