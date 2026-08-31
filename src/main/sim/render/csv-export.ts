// CSV 导出：每轮每条目一行
// 列：round, entryId, intrinsicValue, priority, activation, userSilence, modelSilence, state, userHit, modelHit
import * as fs from "fs";
import * as path from "path";
import type { SimResult } from "../sim-types";

export function exportCsv(result: SimResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, `${result.scenario}.csv`);
  const lines: string[] = ["round,entryId,intrinsicValue,priority,activation,userSilence,modelSilence,state,userHit,modelHit"];
  for (let r = 0; r < result.snapshots.length; r++) {
    for (const s of result.snapshots[r]) {
      lines.push([
        r,
        s.entryId,
        s.intrinsicValue,
        s.priority,
        s.activation.toFixed(3),
        s.userSilence,
        s.modelSilence,
        s.state,
        s.userHit ? 1 : 0,
        s.modelHit ? 1 : 0,
      ].join(","));
    }
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}
