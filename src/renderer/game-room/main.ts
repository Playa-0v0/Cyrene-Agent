import "../ui/theme";
import type { ExtraGameId, GameId, GameOutcome, GameResult, GameRoomStats } from "../../shared/game-room-types";
import { chooseCyreneMove, getWinner, type Cell } from "./game-logic";
import { setupExtraGames } from "./extra-games";
import { setupCyreneQuiz } from "./cyrene-quiz";
import "./game-room.css";

type GameRoomApi = {
  getStats: () => Promise<GameRoomStats>;
  recordResult: (payload: GameResult) => Promise<GameRoomStats>;
  resetStats: () => Promise<GameRoomStats>;
  react: (name: string) => void;
};

declare global {
  interface Window { gameRoom?: GameRoomApi; }
}

const QUESTIONS = [
  { text: "如果今晚能偷走一小時，我們要把它藏在哪裡？", options: ["安靜的海邊", "亮著燈的房間"], cyrene: 0 },
  { text: "一起迷路時，你希望我們怎麼辦？", options: ["跟著直覺走", "先畫一張地圖"], cyrene: 0 },
  { text: "哪一種小事更像幸福？", options: ["分享同一副耳機", "留一盞燈等對方"], cyrene: 1 },
  { text: "如果只能留下一種季節的聲音？", options: ["夏夜的蟲鳴", "冬天窗外的雨"], cyrene: 0 },
  { text: "我們的秘密基地應該有什麼？", options: ["看不完的故事", "永遠溫熱的甜點"], cyrene: 0 },
  { text: "贏下遊戲後，最適合的慶祝方式？", options: ["再來一局", "交換一個秘密"], cyrene: 1 },
  { text: "哪一顆星比較適合代表我們？", options: ["總會找到彼此的雙星", "慢慢變亮的新星"], cyrene: 0 },
] as const;

const lobby = document.getElementById("lobby") as HTMLElement;
const playStage = document.getElementById("play-stage") as HTMLElement;
const resonanceGame = document.getElementById("resonance-game") as HTMLElement;
const ticGame = document.getElementById("tic-game") as HTMLElement;
const gameTitle = document.getElementById("game-title") as HTMLElement;
const gameKicker = document.getElementById("game-kicker") as HTMLElement;
const roundPill = document.getElementById("round-pill") as HTMLElement;
const cyreneLine = document.getElementById("cyrene-line") as HTMLElement;
const questionText = document.getElementById("question-text") as HTMLElement;
const answerGrid = document.getElementById("answer-grid") as HTMLElement;
const reveal = document.getElementById("reveal") as HTMLElement;
const resonanceTrack = document.getElementById("resonance-track") as HTMLElement;
const boardEl = document.getElementById("board") as HTMLElement;
const turnIndicator = document.getElementById("turn-indicator") as HTMLElement;
const restartTic = document.getElementById("restart-tic") as HTMLButtonElement;

let resonanceQuestions: typeof QUESTIONS[number][] = [];
let resonanceRound = 0;
let resonanceMatches = 0;
let resonanceResults: boolean[] = [];
let cyreneChoice = 0;
let board: Cell[] = Array(9).fill(null);
let ticLocked = false;
let activeGame: GameId | null = null;

const EXTRA_CONTAINERS: Record<ExtraGameId, string> = {
  "rock-paper-scissors": "rps-game",
  "memory-match": "memory-game",
  "connect-four": "connect-game",
  "twenty-questions": "twenty-game",
  "truth-cards": "truth-game",
  story: "story-game",
  "cyrene-quiz": "quiz-game",
  ropebound: "ropebound-game",
};

function shuffledQuestions(): typeof QUESTIONS[number][] {
  return [...QUESTIONS].sort(() => Math.random() - 0.5).slice(0, 5);
}

function setLine(text: string, reaction?: string): void {
  cyreneLine.textContent = text;
  if (reaction) window.gameRoom?.react(reaction);
}

function showLobby(): void {
  activeGame = null;
  lobby.hidden = false;
  playStage.hidden = true;
  hideAllGames();
}

function showStage(): void {
  lobby.hidden = true;
  playStage.hidden = false;
  playStage.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideAllGames(): void {
  resonanceGame.hidden = true;
  ticGame.hidden = true;
  playStage.classList.remove("play-stage--wide");
  document.querySelectorAll<HTMLElement>(".extra-game").forEach((game) => { game.hidden = true; });
}

function activateExtraGame(id: ExtraGameId, title: string, kicker: string, pill: string): void {
  activeGame = id;
  showStage();
  hideAllGames();
  gameKicker.textContent = kicker;
  gameTitle.textContent = title;
  roundPill.textContent = pill;
  document.getElementById(EXTRA_CONTAINERS[id])!.hidden = false;
}

function updateStats(stats: GameRoomStats): void {
  const extraScores = Object.values(stats.extras);
  const total = stats.resonance.played + stats.ticTacToe.played + extraScores.reduce((sum, score) => sum + score.played, 0);
  const totalUserWins = stats.ticTacToe.userWins + extraScores.reduce((sum, score) => sum + score.userWins, 0);
  const rounds = document.getElementById("stat-rounds");
  const resonance = document.getElementById("stat-resonance");
  const wins = document.getElementById("stat-wins");
  if (rounds) rounds.textContent = String(total);
  if (resonance) resonance.textContent = stats.resonance.played ? `${stats.resonance.bestMatches}/5` : "—";
  if (wins) wins.textContent = String(totalUserWins);
}

async function recordExtraResult(game: ExtraGameId, outcome: GameOutcome): Promise<GameRoomStats | null> {
  try {
    if (!window.gameRoom) return null;
    const stats = await window.gameRoom.recordResult({ game, outcome });
    updateStats(stats);
    return stats;
  } catch (error) {
    console.warn(`儲存 ${game} 紀錄失敗`, error);
    return null;
  }
}

async function refreshStats(): Promise<void> {
  try {
    if (window.gameRoom) updateStats(await window.gameRoom.getStats());
  } catch (error) {
    console.warn("讀取遊戲紀錄失敗", error);
  }
}

function renderTrack(): void {
  resonanceTrack.replaceChildren();
  for (let i = 0; i < 5; i += 1) {
    const item = document.createElement("span");
    item.className = "track-star";
    if (i < resonanceResults.length) item.classList.add(resonanceResults[i] ? "is-match" : "is-miss");
    resonanceTrack.appendChild(item);
  }
}

function renderResonanceRound(): void {
  const question = resonanceQuestions[resonanceRound];
  roundPill.textContent = `${resonanceRound + 1} / 5`;
  questionText.textContent = question.text;
  reveal.hidden = true;
  answerGrid.replaceChildren();
  renderTrack();

  // 昔漣的答案在玩家作答前就決定，揭曉時不會追著玩家改答案。
  cyreneChoice = Math.random() < 0.82 ? question.cyrene : 1 - question.cyrene;
  question.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-button";
    button.textContent = option;
    button.addEventListener("click", () => revealResonance(index));
    answerGrid.appendChild(button);
  });
  setLine(resonanceRound === 0 ? "我已經選好了。你慢慢想，不許偷看我的答案喔。" : "這次我也先選好了，來看看星星會不會連起來。", resonanceRound === 0 ? "眨眨眼" : undefined);
}

function revealResonance(userChoice: number): void {
  const buttons = [...answerGrid.querySelectorAll<HTMLButtonElement>(".answer-button")];
  buttons.forEach((button, index) => {
    button.disabled = true;
    if (index === userChoice) button.classList.add("is-user");
    if (index === cyreneChoice) button.classList.add("is-cyrene");
    if (index === userChoice && index === cyreneChoice) button.classList.add("is-both");
  });

  const matched = userChoice === cyreneChoice;
  resonanceResults.push(matched);
  if (matched) resonanceMatches += 1;
  renderTrack();
  reveal.hidden = false;
  reveal.textContent = matched ? "同一個答案。這顆星亮起來了。" : "這次擦肩而過，下一顆也許會靠得更近。";
  setLine(matched ? "抓到你心裡的答案了。這算不算小小的默契？" : "原來你會選那一邊……好，我悄悄記住了。", matched ? "星星眼" : "問號");

  window.setTimeout(() => {
    if (activeGame !== "resonance") return;
    resonanceRound += 1;
    if (resonanceRound < 5) renderResonanceRound();
    else void finishResonance();
  }, 1350);
}

async function finishResonance(): Promise<void> {
  roundPill.textContent = "完成";
  renderTrack();
  questionText.textContent = `今晚的共鳴是 ${resonanceMatches} / 5`;
  answerGrid.replaceChildren();
  reveal.hidden = false;
  reveal.textContent = resonanceMatches >= 4 ? "兩條星軌幾乎重疊在一起。" : resonanceMatches >= 2 ? "有幾顆星已經找到彼此。" : "答案不同，也讓我多認識你一點。";
  setLine(resonanceMatches >= 4 ? "這麼合拍，我要把今晚收進最亮的那顆星裡。" : "不一樣也很好，下次我會猜得更準一點。", resonanceMatches >= 4 ? "閃閃發光" : "笑一笑");

  const again = document.createElement("button");
  again.type = "button";
  again.className = "primary-button";
  again.textContent = "再測一次默契";
  again.addEventListener("click", startResonance);
  answerGrid.appendChild(again);

  try {
    if (window.gameRoom) updateStats(await window.gameRoom.recordResult({ game: "resonance", outcome: "draw", matches: resonanceMatches }));
  } catch (error) {
    console.warn("儲存默契紀錄失敗", error);
  }
}

function startResonance(): void {
  activeGame = "resonance";
  showStage();
  hideAllGames();
  gameKicker.textContent = "雙人共鳴測試";
  gameTitle.textContent = "心有靈犀";
  resonanceGame.hidden = false;
  resonanceQuestions = shuffledQuestions();
  resonanceRound = 0;
  resonanceMatches = 0;
  resonanceResults = [];
  renderResonanceRound();
}

function renderBoard(): void {
  boardEl.replaceChildren();
  board.forEach((mark, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.setAttribute("role", "gridcell");
    cell.dataset.mark = mark ?? "";
    cell.textContent = mark === "user" ? "✿" : mark === "cyrene" ? "✦" : "";
    cell.disabled = ticLocked || mark !== null;
    cell.setAttribute("aria-label", mark === "user" ? "你的花瓣" : mark === "cyrene" ? "昔漣的星光" : `空格 ${index + 1}`);
    cell.addEventListener("click", () => playUserMove(index));
    boardEl.appendChild(cell);
  });
}

function playUserMove(index: number): void {
  if (ticLocked || board[index]) return;
  board[index] = "user";
  renderBoard();
  const result = getWinner(board);
  if (result) { void finishTic(result); return; }

  ticLocked = true;
  turnIndicator.textContent = "昔漣正在挑一顆星的位置…";
  setLine("嗯……這一步，我可要想清楚。", "問號");
  renderBoard();
  window.setTimeout(() => {
    if (activeGame !== "tic-tac-toe") return;
    const move = chooseCyreneMove(board);
    if (move !== null) board[move] = "cyrene";
    ticLocked = false;
    renderBoard();
    const nextResult = getWinner(board);
    if (nextResult) void finishTic(nextResult);
    else {
      turnIndicator.textContent = "輪到你放下花瓣";
      setLine("換你了。讓我看看你準備把花瓣藏在哪裡。", "眨眨眼");
    }
  }, 620);
}

async function finishTic(result: "user" | "cyrene" | "draw"): Promise<void> {
  ticLocked = true;
  renderBoard();
  restartTic.hidden = false;
  if (result === "user") {
    turnIndicator.textContent = "花瓣連成了一條線";
    setLine("被你抓住破綻了。這一局是你的，下一局可不一定喔。", "星星眼");
  } else if (result === "cyrene") {
    turnIndicator.textContent = "星光連成了一條線";
    setLine("找到星軌了。要不要讓我得意一下下？", "可愛一下");
  } else {
    turnIndicator.textContent = "花瓣與星光鋪滿棋盤";
    setLine("平手。看來我們誰也不肯讓對方孤單呢。", "笑一笑");
  }
  try {
    if (window.gameRoom) updateStats(await window.gameRoom.recordResult({ game: "tic-tac-toe", outcome: result }));
  } catch (error) {
    console.warn("儲存井字棋紀錄失敗", error);
  }
}

function startTic(): void {
  activeGame = "tic-tac-toe";
  showStage();
  hideAllGames();
  gameKicker.textContent = "花瓣對星光";
  gameTitle.textContent = "星軌井字棋";
  roundPill.textContent = "你先手";
  ticGame.hidden = false;
  board = Array(9).fill(null);
  ticLocked = false;
  restartTic.hidden = true;
  turnIndicator.textContent = "輪到你放下花瓣";
  setLine("你是花瓣，我是星光。三個連成一線就算贏，請先手吧。", "笑一笑");
  renderBoard();
}

const extraDeps = {
  activate: activateExtraGame,
  setLine,
  record: recordExtraResult,
};
const extraStarts: Record<ExtraGameId, () => void> = {
  ...setupExtraGames(extraDeps),
  "cyrene-quiz": setupCyreneQuiz({
    activate: (title, kicker, pill) => activateExtraGame("cyrene-quiz", title, kicker, pill),
    setLine,
    record: (outcome) => recordExtraResult("cyrene-quiz", outcome),
  }),
  ropebound: () => {
    activateExtraGame("ropebound", "繩結同行", "原版遊戲 · 新增昔漣", "單人／雙人");
    playStage.classList.add("play-stage--wide");
    setLine("原本的玩法和角色動作都留在這裡；這次我也加入同行。", "笑一笑");
    window.setTimeout(() => document.getElementById("ropebound-frame")?.focus(), 0);
  },
} as Record<ExtraGameId, () => void>;

document.querySelectorAll<HTMLButtonElement>("[data-game]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.game as GameId;
    if (id === "resonance") startResonance();
    else if (id === "tic-tac-toe") startTic();
    else extraStarts[id]();
  });
});

document.getElementById("back-button")?.addEventListener("click", showLobby);
restartTic.addEventListener("click", startTic);
document.getElementById("reset-stats")?.addEventListener("click", async () => {
  try {
    if (window.gameRoom) updateStats(await window.gameRoom.resetStats());
    setLine("紀錄清空了，我們可以重新畫一張星圖。", "回正");
  } catch (error) {
    console.warn("清除遊戲紀錄失敗", error);
  }
});

void refreshStats();
