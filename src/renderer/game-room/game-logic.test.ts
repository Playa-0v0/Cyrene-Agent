import { describe, expect, it } from "vitest";
import { chooseCyreneMove, getWinner, type Cell } from "./game-logic";

describe("tic-tac-toe logic", () => {
  it("detects wins and draws", () => {
    expect(getWinner(["user", "user", "user", null, null, null, null, null, null])).toBe("user");
    expect(getWinner(["user", "cyrene", "user", "user", "cyrene", "cyrene", "cyrene", "user", "user"])).toBe("draw");
  });

  it("takes a winning move before blocking", () => {
    const board: Cell[] = ["cyrene", "cyrene", null, "user", "user", null, null, null, null];
    expect(chooseCyreneMove(board, () => 0.5)).toBe(2);
  });

  it("blocks the player when there is no immediate win", () => {
    const board: Cell[] = ["user", "user", null, null, "cyrene", null, null, null, null];
    expect(chooseCyreneMove(board, () => 0.5)).toBe(2);
  });
});
