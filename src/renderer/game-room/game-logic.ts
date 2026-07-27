export type Mark = "user" | "cyrene";
export type Cell = Mark | null;

export const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export function getWinner(board: Cell[]): Mark | "draw" | null {
  for (const [a, b, c] of WINNING_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? "draw" : null;
}

function openCells(board: Cell[]): number[] {
  return board.flatMap((cell, index) => cell ? [] : [index]);
}

function findCompletingMove(board: Cell[], mark: Mark): number | null {
  for (const line of WINNING_LINES) {
    const marks = line.filter((index) => board[index] === mark).length;
    const empty = line.find((index) => board[index] === null);
    if (marks === 2 && empty !== undefined) return empty;
  }
  return null;
}

export function chooseCyreneMove(board: Cell[], random = Math.random): number | null {
  const available = openCells(board);
  if (!available.length) return null;

  // 偶爾故意留一點破綻，讓陪玩比完美演算法更有趣。
  if (random() < 0.18) return available[Math.floor(random() * available.length)];

  const win = findCompletingMove(board, "cyrene");
  if (win !== null) return win;
  const block = findCompletingMove(board, "user");
  if (block !== null) return block;
  if (board[4] === null) return 4;

  const corners = [0, 2, 6, 8].filter((index) => board[index] === null);
  if (corners.length) return corners[Math.floor(random() * corners.length)];
  return available[Math.floor(random() * available.length)];
}
