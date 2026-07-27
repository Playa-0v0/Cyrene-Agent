export const EXTRA_GAME_IDS = [
  "rock-paper-scissors",
  "memory-match",
  "connect-four",
  "twenty-questions",
  "truth-cards",
  "story",
  "cyrene-quiz",
  "ropebound",
] as const;

export type ExtraGameId = typeof EXTRA_GAME_IDS[number];
export type GameId = "resonance" | "tic-tac-toe" | ExtraGameId;
export type GameOutcome = "user" | "cyrene" | "draw";

export interface ScoreStats {
  played: number;
  userWins: number;
  cyreneWins: number;
  draws: number;
}

export interface GameRoomStats {
  resonance: { played: number; bestMatches: number; totalMatches: number };
  ticTacToe: ScoreStats;
  extras: Record<ExtraGameId, ScoreStats>;
}

export interface GameResult {
  game: GameId;
  outcome: GameOutcome;
  matches?: number;
}
