// ASCII 条形图：每轮快照所有非常驻条目 A 值横条
import type { SimResult } from "../sim-types";

export function renderBars(result: SimResult, sampleEvery: number = 5): void {
  console.log("\n=== ASCII 条形图（每轮快照）===");
  const nonPerm = result.entries.filter((e) => !e.permanent);
  for (let r = 0; r < result.snapshots.length; r++) {
    if (r % sampleEvery !== 0 && r !== result.snapshots.length - 1) continue;
    const round = result.rounds[r];
    console.log(`\n--- R${r}  user="${round.userText.slice(0, 30).replace(/\n/g, " ")}"  note=${round.note ?? ""} ---`);
    const snaps = result.snapshots[r].filter((s) => nonPerm.find((e) => e.id === s.entryId));
    snaps.sort((a, b) => b.activation - a.activation);
    for (const s of snaps) {
      const barLen = Math.round(s.activation / 2);  // 0~50 长度
      const bar = "█".repeat(barLen);
      const mark = s.state === "Active" ? "▲" : s.state === "Dormant" ? "▒" : "·";
      const shortId = s.entryId.length > 30 ? "…" + s.entryId.slice(-28) : s.entryId;
      console.log(`  ${mark} ${shortId.padEnd(32)}  I=${String(s.intrinsicValue).padStart(3)}  A=${s.activation.toFixed(1).padStart(5)}  ${bar}`);
    }
  }
}
