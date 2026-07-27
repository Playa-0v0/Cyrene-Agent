import { describe, expect, it } from "vitest";
import { chooseConnectMove, createMemoryDeck, dropInColumn, getConnectWinner, resolveRps, type ConnectCell } from "./extra-game-logic";

describe("extra game logic", () => {
  it("resolves rock paper scissors", () => {
    expect(resolveRps("rock", "scissors")).toBe("user");
    expect(resolveRps("paper", "scissors")).toBe("cyrene");
    expect(resolveRps("rock", "rock")).toBe("draw");
  });

  it("drops tokens and detects four in a row", () => {
    const board: ConnectCell[] = Array(42).fill(null);
    [0, 1, 2, 3].forEach((col) => dropInColumn(board, col, "user"));
    expect(getConnectWinner(board)).toBe("user");
  });

  it("takes a winning connect-four move", () => {
    const board: ConnectCell[] = Array(42).fill(null);
    [0, 1, 2].forEach((col) => dropInColumn(board, col, "cyrene"));
    expect(chooseConnectMove(board, () => 0.5)).toBe(3);
  });

  it("creates pairs in a memory deck", () => {
    const deck = createMemoryDeck(["花", "星", "月"], () => 0.4);
    expect(deck).toHaveLength(6);
    expect(deck.filter((card) => card.symbol === "花")).toHaveLength(2);
  });
});
