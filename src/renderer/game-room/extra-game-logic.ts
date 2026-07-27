import type { Mark } from "./game-logic";

export type RpsChoice = "rock" | "paper" | "scissors";

export function resolveRps(user: RpsChoice, cyrene: RpsChoice): "user" | "cyrene" | "draw" {
  if (user === cyrene) return "draw";
  if (
    (user === "rock" && cyrene === "scissors") ||
    (user === "paper" && cyrene === "rock") ||
    (user === "scissors" && cyrene === "paper")
  ) return "user";
  return "cyrene";
}

export type ConnectCell = Mark | null;
export const CONNECT_ROWS = 6;
export const CONNECT_COLS = 7;

export function dropInColumn(board: ConnectCell[], column: number, mark: Mark): number | null {
  if (column < 0 || column >= CONNECT_COLS) return null;
  for (let row = CONNECT_ROWS - 1; row >= 0; row -= 1) {
    const index = row * CONNECT_COLS + column;
    if (board[index] === null) {
      board[index] = mark;
      return index;
    }
  }
  return null;
}

export function getConnectWinner(board: ConnectCell[]): Mark | "draw" | null {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
  for (let row = 0; row < CONNECT_ROWS; row += 1) {
    for (let col = 0; col < CONNECT_COLS; col += 1) {
      const mark = board[row * CONNECT_COLS + col];
      if (!mark) continue;
      for (const [dr, dc] of directions) {
        let connected = true;
        for (let step = 1; step < 4; step += 1) {
          const nextRow = row + dr * step;
          const nextCol = col + dc * step;
          if (
            nextRow < 0 || nextRow >= CONNECT_ROWS || nextCol < 0 || nextCol >= CONNECT_COLS ||
            board[nextRow * CONNECT_COLS + nextCol] !== mark
          ) {
            connected = false;
            break;
          }
        }
        if (connected) return mark;
      }
    }
  }
  return board.every(Boolean) ? "draw" : null;
}

function availableColumns(board: ConnectCell[]): number[] {
  return Array.from({ length: CONNECT_COLS }, (_, col) => col).filter((col) => board[col] === null);
}

function winningColumn(board: ConnectCell[], mark: Mark): number | null {
  for (const col of availableColumns(board)) {
    const copy = [...board];
    dropInColumn(copy, col, mark);
    if (getConnectWinner(copy) === mark) return col;
  }
  return null;
}

export function chooseConnectMove(board: ConnectCell[], random = Math.random): number | null {
  const available = availableColumns(board);
  if (!available.length) return null;
  const win = winningColumn(board, "cyrene");
  if (win !== null) return win;
  const block = winningColumn(board, "user");
  if (block !== null && random() > 0.12) return block;
  const preferred = [3, 2, 4, 1, 5, 0, 6].filter((col) => available.includes(col));
  const range = Math.min(3, preferred.length);
  return preferred[Math.floor(random() * range)] ?? available[0];
}

export interface MemoryCard {
  id: number;
  symbol: string;
  matched: boolean;
}

export function createMemoryDeck(symbols: string[], random = Math.random): MemoryCard[] {
  const deck = [...symbols, ...symbols].map((symbol, id) => ({ id, symbol, matched: false }));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
