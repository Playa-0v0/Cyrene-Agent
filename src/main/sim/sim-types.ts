// ── Simulator 共享類型 ──
import type { DmaeState, DmaeParams, WorldbookEntry, EntryState } from "../rag/worldbook";

export interface Round {
  index: number;            // 0-based 輪次
  userText: string;         // 本輪用戶輸入
  modelText: string;        // 本輪模型回覆（用於 modelHit 檢測）
  note?: string;            // 調試註釋
}

export interface EntrySnapshot {
  entryId: string;
  intrinsicValue: number;
  priority: number;
  activation: number;
  userSilence: number;
  modelSilence: number;
  state: DmaeState;
  userHit: boolean;         // 本輪是否被 user 命中
  modelHit: boolean;        // 本輪是否被 model 命中
}

export interface SimResult {
  scenario: string;
  params: DmaeParams;
  entries: WorldbookEntry[];
  rounds: Round[];
  snapshots: EntrySnapshot[][];   // [roundIdx][entryIdx] = 該輪該條目的快照
  // 統計結果（由 render/stats.ts 填充）
  stats: SimStats;
}

export interface SimStats {
  promptOccupancy: Map<string, number>;   // entryId → 佔用率 0~1
  avgActiveLife: Map<string, number>;     // entryId → 一次激活平均持續輪數
  promptRanking: Map<number, string[]>;   // roundIdx → 該輪按 A 降序的 entryId 列表
  totalRounds: number;
}

export interface Scenario {
  name: string;
  buildRounds(): Round[];
  buildEntries(): WorldbookEntry[];       // fixture → entry 解析
  description: string;
}
