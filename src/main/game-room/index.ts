import { app, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { findAction, type Live2DTarget } from "../../shared/live2d-actions";
import { EXTRA_GAME_IDS, type ExtraGameId, type GameResult, type GameRoomStats, type ScoreStats } from "../../shared/game-room-types";

const EMPTY_SCORE: ScoreStats = { played: 0, userWins: 0, cyreneWins: 0, draws: 0 };

function emptyExtraStats(): Record<ExtraGameId, ScoreStats> {
  return Object.fromEntries(EXTRA_GAME_IDS.map((id) => [id, { ...EMPTY_SCORE }])) as Record<ExtraGameId, ScoreStats>;
}

const EMPTY_STATS: GameRoomStats = {
  resonance: { played: 0, bestMatches: 0, totalMatches: 0 },
  ticTacToe: { ...EMPTY_SCORE },
  extras: emptyExtraStats(),
};

function statsPath(): string {
  return path.join(app.getPath("userData"), "game-room-stats.json");
}

function cloneEmptyStats(): GameRoomStats {
  return JSON.parse(JSON.stringify(EMPTY_STATS)) as GameRoomStats;
}

export function readGameRoomStats(filePath = statsPath()): GameRoomStats {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GameRoomStats>;
    const normalizeScore = (input?: Partial<ScoreStats>): ScoreStats => ({
      played: Math.max(0, Number(input?.played) || 0),
      userWins: Math.max(0, Number(input?.userWins) || 0),
      cyreneWins: Math.max(0, Number(input?.cyreneWins) || 0),
      draws: Math.max(0, Number(input?.draws) || 0),
    });
    const extras = emptyExtraStats();
    for (const id of EXTRA_GAME_IDS) extras[id] = normalizeScore(parsed.extras?.[id]);
    return {
      resonance: {
        played: Math.max(0, Number(parsed.resonance?.played) || 0),
        bestMatches: Math.max(0, Number(parsed.resonance?.bestMatches) || 0),
        totalMatches: Math.max(0, Number(parsed.resonance?.totalMatches) || 0),
      },
      ticTacToe: normalizeScore(parsed.ticTacToe),
      extras,
    };
  } catch {
    return cloneEmptyStats();
  }
}

function writeStats(stats: GameRoomStats, filePath = statsPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(stats, null, 2), "utf8");
}

export function recordGameRoomResult(result: GameResult, filePath = statsPath()): GameRoomStats {
  const stats = readGameRoomStats(filePath);
  if (result.game === "resonance") {
    const matches = Math.max(0, Math.min(5, Math.floor(Number(result.matches) || 0)));
    stats.resonance.played += 1;
    stats.resonance.totalMatches += matches;
    stats.resonance.bestMatches = Math.max(stats.resonance.bestMatches, matches);
  } else {
    const score = result.game === "tic-tac-toe"
      ? stats.ticTacToe
      : stats.extras[result.game as ExtraGameId];
    if (!score) return stats;
    score.played += 1;
    if (result.outcome === "user") score.userWins += 1;
    else if (result.outcome === "cyrene") score.cyreneWins += 1;
    else score.draws += 1;
  }
  writeStats(stats, filePath);
  return stats;
}

export function initGameRoom(sendToLive2D: (channel: string, payload?: unknown) => void): void {
  ipcMain.handle(IPC.GAME_ROOM_GET_STATS, () => readGameRoomStats());
  ipcMain.handle(IPC.GAME_ROOM_RECORD_RESULT, (_event, result: GameResult) => recordGameRoomResult(result));
  ipcMain.handle(IPC.GAME_ROOM_RESET_STATS, () => {
    const stats = cloneEmptyStats();
    writeStats(stats);
    return stats;
  });
  ipcMain.on(IPC.GAME_ROOM_REACT, (_event, alias: unknown) => {
    if (typeof alias !== "string") return;
    const action = findAction(alias);
    if (action) sendToLive2D(IPC.LIVE2D_PLAY_ACTION, action.target satisfies Live2DTarget);
  });
}
