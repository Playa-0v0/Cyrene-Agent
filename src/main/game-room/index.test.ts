import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readGameRoomStats, recordGameRoomResult } from ".";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cy-game-room-"));
  dirs.push(dir);
  return path.join(dir, "stats.json");
}

describe("game room stats", () => {
  it("returns empty stats when no save exists", () => {
    expect(readGameRoomStats(tempFile())).toEqual({
      resonance: { played: 0, bestMatches: 0, totalMatches: 0 },
      ticTacToe: { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
      extras: {
        "rock-paper-scissors": { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        "memory-match": { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        "connect-four": { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        "twenty-questions": { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        "truth-cards": { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        story: { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        "cyrene-quiz": { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
        ropebound: { played: 0, userWins: 0, cyreneWins: 0, draws: 0 },
      },
    });
  });

  it("records resonance and tic-tac-toe results", () => {
    const file = tempFile();
    recordGameRoomResult({ game: "resonance", outcome: "draw", matches: 4 }, file);
    recordGameRoomResult({ game: "tic-tac-toe", outcome: "user" }, file);
    recordGameRoomResult({ game: "connect-four", outcome: "cyrene" }, file);
    const stats = readGameRoomStats(file);
    expect(stats.resonance).toEqual({ played: 1, bestMatches: 4, totalMatches: 4 });
    expect(stats.ticTacToe).toEqual({ played: 1, userWins: 1, cyreneWins: 0, draws: 0 });
    expect(stats.extras["connect-four"]).toEqual({ played: 1, userWins: 0, cyreneWins: 1, draws: 0 });
  });
});
