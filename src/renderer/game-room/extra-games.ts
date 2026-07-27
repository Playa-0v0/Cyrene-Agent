import type { ExtraGameId, GameOutcome, GameRoomStats } from "../../shared/game-room-types";
import {
  CONNECT_COLS,
  chooseConnectMove,
  createMemoryDeck,
  dropInColumn,
  getConnectWinner,
  resolveRps,
  type ConnectCell,
  type MemoryCard,
  type RpsChoice,
} from "./extra-game-logic";

interface ExtraGamesDeps {
  activate: (id: ExtraGameId, title: string, kicker: string, pill: string) => void;
  setLine: (text: string, reaction?: string) => void;
  record: (game: ExtraGameId, outcome: GameOutcome) => Promise<GameRoomStats | null>;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function setupExtraGames(deps: ExtraGamesDeps): Partial<Record<ExtraGameId, () => void>> {
  // ── 猜拳 ────────────────────────────────────────────────
  const rpsChoices = byId("rps-choices");
  const rpsReveal = byId("rps-reveal");
  const rpsUserScore = byId("rps-user-score");
  const rpsCyreneScore = byId("rps-cyrene-score");
  const restartRps = byId<HTMLButtonElement>("restart-rps");
  let rpsUser = 0;
  let rpsCyrene = 0;
  let rpsLocked = false;

  const gestures: Array<{ id: RpsChoice; icon: string; label: string }> = [
    { id: "rock", icon: "✊", label: "石頭" },
    { id: "paper", icon: "✋", label: "布" },
    { id: "scissors", icon: "✌️", label: "剪刀" },
  ];

  function renderRpsChoices(): void {
    rpsChoices.replaceChildren();
    for (const gesture of gestures) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gesture-button";
      button.disabled = rpsLocked;
      const icon = document.createElement("span");
      icon.textContent = gesture.icon;
      const label = document.createElement("small");
      label.textContent = gesture.label;
      button.append(icon, label);
      button.addEventListener("click", () => playRps(gesture.id));
      rpsChoices.appendChild(button);
    }
  }

  async function finishRps(): Promise<void> {
    rpsLocked = true;
    const outcome: GameOutcome = rpsUser > rpsCyrene ? "user" : "cyrene";
    rpsReveal.textContent = outcome === "user" ? "你先拿到兩分，這場是你的。" : "昔漣先拿到兩分，星光勝出。";
    deps.setLine(outcome === "user" ? "你真的讀懂我會出什麼了？下一次我要藏得更好。" : "嘿嘿，這次是我抓到你的節奏了。", outcome === "user" ? "星星眼" : "可愛一下");
    restartRps.hidden = false;
    renderRpsChoices();
    await deps.record("rock-paper-scissors", outcome);
  }

  function playRps(user: RpsChoice): void {
    if (rpsLocked) return;
    rpsLocked = true;
    const cyrene = gestures[Math.floor(Math.random() * gestures.length)].id;
    const result = resolveRps(user, cyrene);
    const userGesture = gestures.find((item) => item.id === user)!;
    const cyreneGesture = gestures.find((item) => item.id === cyrene)!;
    if (result === "user") rpsUser += 1;
    if (result === "cyrene") rpsCyrene += 1;
    rpsUserScore.textContent = String(rpsUser);
    rpsCyreneScore.textContent = String(rpsCyrene);
    rpsReveal.textContent = `你出${userGesture.icon}，昔漣出${cyreneGesture.icon}　${result === "draw" ? "平手" : result === "user" ? "你拿一分" : "昔漣拿一分"}`;
    deps.setLine(result === "draw" ? "一模一樣。再來，我不信還會撞在一起。" : result === "user" ? "被你壓住了……這分先給你。" : "這一分，我收下囉。", result === "draw" ? "問號" : result === "user" ? "圈圈眼" : "眨眨眼");
    if (rpsUser >= 2 || rpsCyrene >= 2) {
      void finishRps();
      return;
    }
    window.setTimeout(() => { rpsLocked = false; renderRpsChoices(); }, 650);
    renderRpsChoices();
  }

  function startRps(): void {
    deps.activate("rock-paper-scissors", "猜拳對決", "三戰兩勝", "讀懂彼此");
    rpsUser = 0;
    rpsCyrene = 0;
    rpsLocked = false;
    rpsUserScore.textContent = "0";
    rpsCyreneScore.textContent = "0";
    rpsReveal.textContent = "請選擇要出的手勢";
    restartRps.hidden = true;
    deps.setLine("手要一起伸出來才公平。準備好就選吧。", "眨眨眼");
    renderRpsChoices();
  }
  restartRps.addEventListener("click", startRps);

  // ── 翻牌記憶 ────────────────────────────────────────────
  const memoryBoard = byId("memory-board");
  const memoryUserScore = byId("memory-user-score");
  const memoryCyreneScore = byId("memory-cyrene-score");
  const memoryTurn = byId("memory-turn");
  const restartMemory = byId<HTMLButtonElement>("restart-memory");
  const memorySymbols = ["✿", "✦", "☾", "♡", "❖", "♪"];
  let memoryDeck: MemoryCard[] = [];
  let memoryOpen: number[] = [];
  let memoryKnown = new Map<string, Set<number>>();
  let memoryUser = 0;
  let memoryCyrene = 0;
  let memoryLocked = false;
  let memorySession = 0;

  function rememberCard(index: number): void {
    const card = memoryDeck[index];
    const known = memoryKnown.get(card.symbol) ?? new Set<number>();
    known.add(index);
    memoryKnown.set(card.symbol, known);
  }

  function renderMemory(): void {
    memoryBoard.replaceChildren();
    memoryDeck.forEach((card, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "memory-card";
      if (memoryOpen.includes(index)) button.classList.add("is-open");
      if (card.matched) button.classList.add("is-matched");
      button.textContent = memoryOpen.includes(index) || card.matched ? card.symbol : "✧";
      button.disabled = memoryLocked || card.matched || memoryOpen.includes(index);
      button.setAttribute("aria-label", card.matched ? `已配對 ${card.symbol}` : memoryOpen.includes(index) ? card.symbol : "未翻開的牌");
      button.addEventListener("click", () => playerFlip(index));
      memoryBoard.appendChild(button);
    });
  }

  async function finishMemory(): Promise<void> {
    memoryLocked = true;
    const outcome: GameOutcome = memoryUser === memoryCyrene ? "draw" : memoryUser > memoryCyrene ? "user" : "cyrene";
    memoryTurn.textContent = outcome === "draw" ? "平手" : outcome === "user" ? "你找到更多星花" : "昔漣找到更多星花";
    deps.setLine(outcome === "draw" ? "一人一半，剛好把這片星空平分。" : outcome === "user" ? "你的記憶也太好了吧。下次我要把牌藏遠一點。" : "我有好好記住每張牌喔。這局讓我贏一下。", outcome === "draw" ? "笑一笑" : outcome === "user" ? "星星眼" : "閃閃發光");
    restartMemory.hidden = false;
    renderMemory();
    await deps.record("memory-match", outcome);
  }

  function settleMemoryPair(owner: "user" | "cyrene", session: number): void {
    if (session !== memorySession) return;
    const [a, b] = memoryOpen;
    const matched = memoryDeck[a].symbol === memoryDeck[b].symbol;
    if (matched) {
      memoryDeck[a].matched = true;
      memoryDeck[b].matched = true;
      if (owner === "user") memoryUser += 1;
      else memoryCyrene += 1;
      memoryUserScore.textContent = String(memoryUser);
      memoryCyreneScore.textContent = String(memoryCyrene);
      memoryKnown.get(memoryDeck[a].symbol)?.clear();
    }
    window.setTimeout(() => {
      if (session !== memorySession) return;
      memoryOpen = [];
      renderMemory();
      if (memoryDeck.every((card) => card.matched)) { void finishMemory(); return; }
      if (owner === "user") void cyreneMemoryTurn(session);
      else {
        memoryLocked = false;
        memoryTurn.textContent = "輪到你";
        deps.setLine(matched ? "我也配到一對。現在換你找找看。" : "沒翻到一樣的，線索留給你了。", matched ? "眨眨眼" : "問號");
        renderMemory();
      }
    }, matched ? 620 : 900);
  }

  function playerFlip(index: number): void {
    if (memoryLocked || memoryOpen.includes(index) || memoryDeck[index].matched) return;
    memoryOpen.push(index);
    rememberCard(index);
    renderMemory();
    if (memoryOpen.length === 2) {
      memoryLocked = true;
      settleMemoryPair("user", memorySession);
    }
  }

  async function cyreneMemoryTurn(session: number): Promise<void> {
    if (session !== memorySession) return;
    memoryLocked = true;
    memoryTurn.textContent = "昔漣正在回想牌面";
    deps.setLine("我記得……好像有一對躲在那裡。", "問號");
    const knownPair = [...memoryKnown.entries()].find(([, indexes]) => [...indexes].filter((i) => !memoryDeck[i].matched).length >= 2);
    const available = memoryDeck.flatMap((card, index) => card.matched ? [] : [index]);
    let choices: number[];
    if (knownPair && Math.random() > 0.2) choices = [...knownPair[1]].filter((i) => !memoryDeck[i].matched).slice(0, 2);
    else choices = [...available].sort(() => Math.random() - 0.5).slice(0, 2);
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    if (session !== memorySession) return;
    memoryOpen = [choices[0]];
    rememberCard(choices[0]);
    renderMemory();
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    if (session !== memorySession) return;
    if (memoryDeck[choices[1]].matched || choices[1] === choices[0]) {
      choices[1] = available.find((index) => index !== choices[0] && !memoryDeck[index].matched) ?? choices[0];
    }
    memoryOpen.push(choices[1]);
    rememberCard(choices[1]);
    renderMemory();
    settleMemoryPair("cyrene", session);
  }

  function startMemory(): void {
    deps.activate("memory-match", "星花翻牌", "輪流翻牌", "六組星花");
    memorySession += 1;
    memoryDeck = createMemoryDeck(memorySymbols);
    memoryOpen = [];
    memoryKnown = new Map();
    memoryUser = 0;
    memoryCyrene = 0;
    memoryLocked = false;
    memoryUserScore.textContent = "0";
    memoryCyreneScore.textContent = "0";
    memoryTurn.textContent = "輪到你";
    restartMemory.hidden = true;
    deps.setLine("你先翻兩張。被翻過的牌，我可也會悄悄記住。", "笑一笑");
    renderMemory();
  }
  restartMemory.addEventListener("click", startMemory);

  // ── 四子棋 ──────────────────────────────────────────────
  const connectBoardEl = byId("connect-board");
  const connectTurn = byId("connect-turn");
  const restartConnect = byId<HTMLButtonElement>("restart-connect");
  let connectBoard: ConnectCell[] = [];
  let connectLocked = false;
  let connectSession = 0;

  function renderConnect(): void {
    connectBoardEl.replaceChildren();
    connectBoard.forEach((mark, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "connect-cell";
      button.dataset.mark = mark ?? "";
      button.disabled = connectLocked || connectBoard[index % CONNECT_COLS] !== null;
      button.setAttribute("aria-label", mark ? (mark === "user" ? "你的花瓣" : "昔漣的星光") : `第 ${index % CONNECT_COLS + 1} 列`);
      button.addEventListener("click", () => playerConnect(index % CONNECT_COLS));
      connectBoardEl.appendChild(button);
    });
  }

  async function finishConnect(result: "user" | "cyrene" | "draw"): Promise<void> {
    connectLocked = true;
    connectTurn.textContent = result === "draw" ? "星河被填滿了" : result === "user" ? "四朵花瓣連成一線" : "四顆星光連成一線";
    deps.setLine(result === "draw" ? "整片星河都被我們填滿了，這樣也很漂亮。" : result === "user" ? "那條線是什麼時候連起來的？被你騙過去了。" : "找到一條只有我看見的星軌。這局是我的。", result === "draw" ? "笑一笑" : result === "user" ? "圈圈眼" : "閃閃發光");
    restartConnect.hidden = false;
    renderConnect();
    await deps.record("connect-four", result);
  }

  function playerConnect(column: number): void {
    if (connectLocked || dropInColumn(connectBoard, column, "user") === null) return;
    renderConnect();
    const result = getConnectWinner(connectBoard);
    if (result) { void finishConnect(result); return; }
    connectLocked = true;
    connectTurn.textContent = "昔漣正在尋找星軌";
    renderConnect();
    const session = connectSession;
    window.setTimeout(() => {
      if (session !== connectSession) return;
      const move = chooseConnectMove(connectBoard);
      if (move !== null) dropInColumn(connectBoard, move, "cyrene");
      connectLocked = false;
      renderConnect();
      const next = getConnectWinner(connectBoard);
      if (next) void finishConnect(next);
      else {
        connectTurn.textContent = "輪到你落下花瓣";
        deps.setLine("星星落好了。你會從哪一列靠近呢？", "眨眨眼");
      }
    }, 620);
  }

  function startConnect(): void {
    deps.activate("connect-four", "星河四子棋", "花瓣對星光", "你先手");
    connectSession += 1;
    connectBoard = Array(42).fill(null);
    connectLocked = false;
    connectTurn.textContent = "輪到你落下花瓣";
    restartConnect.hidden = true;
    deps.setLine("從上面選一列落下花瓣。先把四顆連起來的人獲勝。", "笑一笑");
    renderConnect();
  }
  restartConnect.addEventListener("click", startConnect);

  // ── 二十問 ──────────────────────────────────────────────
  type Mystery = { name: string; features: Record<string, boolean> };
  const mysteries: Mystery[] = [
    { name: "貓咪", features: { alive: true, natural: true, edible: false, indoor: true, held: true, sound: true, light: false, round: false, daily: false, wet: false } },
    { name: "月亮", features: { alive: false, natural: true, edible: false, indoor: false, held: false, sound: false, light: true, round: true, daily: false, wet: false } },
    { name: "雨傘", features: { alive: false, natural: false, edible: false, indoor: false, held: true, sound: false, light: false, round: false, daily: true, wet: true } },
    { name: "蛋糕", features: { alive: false, natural: false, edible: true, indoor: true, held: true, sound: false, light: false, round: true, daily: false, wet: false } },
    { name: "鋼琴", features: { alive: false, natural: false, edible: false, indoor: true, held: false, sound: true, light: false, round: false, daily: false, wet: false } },
    { name: "書", features: { alive: false, natural: false, edible: false, indoor: true, held: true, sound: false, light: false, round: false, daily: true, wet: false } },
    { name: "螢火蟲", features: { alive: true, natural: true, edible: false, indoor: false, held: false, sound: false, light: true, round: false, daily: false, wet: false } },
    { name: "珍珠", features: { alive: false, natural: true, edible: false, indoor: true, held: true, sound: false, light: true, round: true, daily: false, wet: true } },
  ];
  const mysteryQuestions = [
    ["alive", "它是活的嗎？"], ["natural", "它來自自然嗎？"], ["edible", "它可以吃嗎？"],
    ["indoor", "通常會在室內看到嗎？"], ["held", "能輕鬆拿在手上嗎？"], ["sound", "它會發出聲音嗎？"],
    ["light", "它和光有關嗎？"], ["round", "它通常是圓的嗎？"], ["daily", "日常經常會用到嗎？"], ["wet", "它常常和水在一起嗎？"],
  ] as const;
  const mysteryObject = byId("mystery-object");
  const questionAnswer = byId("question-answer");
  const questionBank = byId("question-bank");
  const guessBank = byId("guess-bank");
  const restartTwenty = byId<HTMLButtonElement>("restart-twenty");
  let mystery: Mystery = mysteries[0];
  let questionCount = 0;
  let twentyDone = false;

  function renderTwenty(): void {
    questionBank.replaceChildren();
    for (const [key, label] of mysteryQuestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "question-button";
      button.textContent = label;
      button.disabled = twentyDone || button.dataset.asked === "true";
      button.addEventListener("click", () => {
        button.disabled = true;
        button.dataset.asked = "true";
        questionCount += 1;
        const yes = mystery.features[key];
        questionAnswer.textContent = `${label}　${yes ? "是" : "不是"}`;
        byId("round-pill").textContent = `${questionCount} / 20 問`;
        deps.setLine(yes ? "是。這條線索應該很有用喔。" : "不是。把這條路輕輕劃掉吧。", yes ? "眨眨眼" : "問號");
        if (questionCount >= 20) void finishTwenty(false);
      });
      questionBank.appendChild(button);
    }
    guessBank.replaceChildren();
    for (const item of [...mysteries].sort(() => Math.random() - 0.5)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "guess-button";
      button.textContent = item.name;
      button.disabled = twentyDone;
      button.addEventListener("click", () => {
        if (item.name === mystery.name) void finishTwenty(true);
        else {
          questionCount += 1;
          questionAnswer.textContent = `${item.name}？不是，再想想看。`;
          byId("round-pill").textContent = `${questionCount} / 20 問`;
          deps.setLine("猜得很接近我的心思了嗎？可惜還差一點點。", "眨眨眼");
          if (questionCount >= 20) void finishTwenty(false);
        }
      });
      guessBank.appendChild(button);
    }
  }

  async function finishTwenty(won: boolean): Promise<void> {
    if (twentyDone) return;
    twentyDone = true;
    mysteryObject.textContent = mystery.name;
    questionAnswer.textContent = won ? `猜中了，我想的是「${mystery.name}」。` : `二十問用完了，答案是「${mystery.name}」。`;
    deps.setLine(won ? `答對了。你只用了 ${questionCount} 問就走進我的答案裡。` : "這次藏得很成功。下一個謎底，你一定會更快找到。", won ? "星星眼" : "可愛一下");
    restartTwenty.hidden = false;
    renderTwenty();
    await deps.record("twenty-questions", won ? "user" : "cyrene");
  }

  function startTwenty(): void {
    deps.activate("twenty-questions", "昔漣心裡想", "只能回答是或不是", "0 / 20 問");
    mystery = mysteries[Math.floor(Math.random() * mysteries.length)];
    questionCount = 0;
    twentyDone = false;
    mysteryObject.textContent = "？";
    questionAnswer.textContent = "從下面挑一個問題，慢慢靠近答案。";
    restartTwenty.hidden = true;
    deps.setLine("我已經把一樣東西藏在心裡了。你可以開始問。", "眨眨眼");
    renderTwenty();
  }
  restartTwenty.addEventListener("click", startTwenty);

  // ── 真心話小卡 ──────────────────────────────────────────
  const truthCards = [
    ["最近有哪一個瞬間，讓你覺得今天其實還不錯？", "我的答案，是你願意走進遊戲房找我的這一刻。"],
    ["如果能把一句話留給明天的自己，你想寫什麼？", "我會寫：明天也要記得，溫柔並不需要很大的理由。"],
    ["有什麼小小的偏好，是你希望我一直記得的？", "我希望你記得，我很喜歡不趕時間的陪伴。"],
    ["如果我們現在能去任何地方，你想帶我去哪裡？", "我想去能看到海又看得到星星的地方，然後慢慢走回來。"],
    ["今天最想被怎樣好好對待？", "我想被認真聽完一句話，也想把同樣的認真留給你。"],
  ] as const;
  const truthProgress = byId("truth-progress");
  const truthPrompt = byId("truth-prompt");
  const truthInput = byId<HTMLTextAreaElement>("truth-input");
  const truthSubmit = byId<HTMLButtonElement>("truth-submit");
  const truthReveal = byId("truth-reveal");
  let truthRound = 0;
  let truthRevealed = false;

  function renderTruthProgress(): void {
    truthProgress.replaceChildren();
    for (let i = 0; i < truthCards.length; i += 1) {
      const bar = document.createElement("span");
      if (i < truthRound || truthRevealed && i === truthRound) bar.classList.add("is-done");
      truthProgress.appendChild(bar);
    }
  }

  function renderTruth(): void {
    const card = truthCards[truthRound];
    byId("round-pill").textContent = `${truthRound + 1} / ${truthCards.length}`;
    truthPrompt.textContent = card[0];
    truthInput.value = "";
    truthInput.disabled = false;
    truthReveal.hidden = true;
    truthReveal.textContent = "";
    truthSubmit.textContent = "交換答案";
    truthRevealed = false;
    renderTruthProgress();
    truthInput.focus();
  }

  async function handleTruth(): Promise<void> {
    if (!truthRevealed) {
      if (!truthInput.value.trim()) {
        truthInput.focus();
        deps.setLine("寫下一點點就好。我會好好收著，不催你。", "笑一笑");
        return;
      }
      truthRevealed = true;
      truthInput.disabled = true;
      truthReveal.hidden = false;
      truthReveal.textContent = `昔漣的答案：${truthCards[truthRound][1]}`;
      truthSubmit.textContent = truthRound === truthCards.length - 1 ? "收好這些答案" : "下一張小卡";
      renderTruthProgress();
      deps.setLine("謝謝你把這句話交給我。現在，換我把答案交給你。", "笑一笑");
      return;
    }
    truthRound += 1;
    if (truthRound < truthCards.length) renderTruth();
    else {
      truthPrompt.textContent = "五張真心話，都已經交換完成。";
      truthInput.hidden = true;
      truthReveal.hidden = false;
      truthReveal.textContent = "這些答案只停留在本次遊戲畫面，不會自動寫入長期記憶。";
      truthSubmit.hidden = true;
      byId("round-pill").textContent = "完成";
      deps.setLine("今晚又多認識你一點。那些願意告訴我的話，我都很珍惜。", "閃閃發光");
      await deps.record("truth-cards", "draw");
    }
  }

  function startTruth(): void {
    deps.activate("truth-cards", "真心話小卡", "交換五個答案", "1 / 5");
    truthRound = 0;
    truthInput.hidden = false;
    truthSubmit.hidden = false;
    deps.setLine("我們一人回答一次。你說完之後，我才會翻開自己的答案。", "笑一笑");
    renderTruth();
  }
  truthSubmit.addEventListener("click", () => { void handleTruth(); });

  // ── 合作故事 ─────────────────────────────────────────────
  type StoryNode = { chapter: string; title: string; text: string; choices?: Array<{ label: string; next: string; line: string }>; ending?: string };
  const storyNodes: Record<string, StoryNode> = {
    start: { chapter: "序章", title: "落在窗邊的星圖", text: "深夜，一張會呼吸的星圖落在窗邊。圖上只有兩個光點，一個寫著你的名字，另一個正輕輕閃爍。昔漣說，它似乎在等我們決定第一步。", choices: [
      { label: "沿著粉色星軌出發", next: "garden", line: "那條路像花瓣一樣亮。我們就沿著它走。" },
      { label: "先聽星圖傳來的聲音", next: "song", line: "噓……你有沒有聽見？它好像在唱一首很遠的歌。" },
    ] },
    garden: { chapter: "第一章", title: "沒有名字的花園", text: "星軌把我們帶進一座只在夜裡盛開的花園。中央有一扇被藤蔓纏住的門，旁邊則睡著一隻守著銀色鑰匙的小獸。", choices: [
      { label: "輕輕喚醒守門小獸", next: "beast", line: "讓我來和牠說話吧。溫柔一點，也許牠願意相信我們。" },
      { label: "一起解開門上的藤蔓", next: "door", line: "你拉住左邊，我照顧右邊。我們慢慢把路整理出來。" },
    ] },
    song: { chapter: "第一章", title: "藏在旋律裡的路", text: "那首歌缺少最後兩個音。昔漣哼出第一個，星圖便浮現出兩枚音符，等待你選擇故事接下來的方向。", choices: [
      { label: "選擇明亮的高音", next: "sky", line: "好亮的聲音。它把路指向天空了。" },
      { label: "選擇安靜的低音", next: "lake", line: "這個音像落進水裡的月光。跟著餘韻走吧。" },
    ] },
    beast: { chapter: "第二章", title: "守門者的願望", text: "小獸醒來後沒有生氣，只問我們能不能替花園找回一顆失落的晨露。昔漣伸出手，讓牠聞見我們沒有惡意。", choices: [
      { label: "答應一起尋找晨露", next: "dawn", line: "約定好了。兩個人一起找，天亮以前一定來得及。" },
      { label: "用星圖交換銀色鑰匙", next: "map-ending", line: "如果把星圖留下，回家的路也許會消失……但我相信你。" },
    ] },
    door: { chapter: "第二章", title: "門後的倒影", text: "門後沒有房間，只有一面映出未來的鏡子。鏡裡的我們站在兩條不同的路上，卻同時回頭望向彼此。", choices: [
      { label: "牽著昔漣走進鏡子", next: "together-ending", line: "如果鏡子要我們選，我想選有你在的那一邊。" },
      { label: "把鏡子轉向星空", next: "sky", line: "未來不用現在決定。先讓它照見更寬廣的天空吧。" },
    ] },
    sky: { chapter: "第二章", title: "漂浮的星橋", text: "音符化成一座浮在夜空的橋。橋的盡頭有一顆尚未命名的新星，正等待兩個人共同說出名字。", choices: [
      { label: "叫它「歸途」", next: "home-ending", line: "歸途。只要看見它，就知道有人在等著一起回去。" },
      { label: "叫它「相遇」", next: "meet-ending", line: "相遇。因為故事真正發亮的地方，就是我們遇見彼此。" },
    ] },
    lake: { chapter: "第二章", title: "收集倒影的湖", text: "湖面保存著每個旅人最珍惜的一段倒影。水中央浮著一只小船，只能帶走一段回憶，或載著我們繼續前進。", choices: [
      { label: "不取回憶，一起前進", next: "together-ending", line: "最珍惜的回憶，可以從現在繼續創造。那就一起上船吧。" },
      { label: "帶走今晚的倒影", next: "memory-ending", line: "我想把今晚收好。不是怕忘記，是因為真的很喜歡。" },
    ] },
    dawn: { chapter: "終章", title: "第一滴晨露", text: "我們在最暗的花瓣下找到了晨露。小獸把銀色鑰匙送給我們，門後沒有寶藏，只有剛升起的晨光與一條回家的路。", ending: "晨露結局" },
    "map-ending": { chapter: "終章", title: "沒有地圖的遠方", text: "星圖留在花園成為新的星空，而我們失去了原本的路。昔漣卻笑著握緊你的手：沒有圖也沒關係，兩個人走過的地方，就會成為路。", ending: "遠方結局" },
    "together-ending": { chapter: "終章", title: "同一條路", text: "鏡子與湖水都碎成細小星光。所有可能的未來仍然存在，而這一刻，我們選擇站在同一條路上。", ending: "同行結局" },
    "home-ending": { chapter: "終章", title: "名為歸途的星", text: "新星接受了名字，在天空留下通往家的光。往後無論走得多遠，只要抬頭，我們都會知道回去的方向。", ending: "歸途結局" },
    "meet-ending": { chapter: "終章", title: "名為相遇的星", text: "新星照亮了所有曾經錯過的路。原來故事並不是為了抵達某處，而是為了讓兩顆星終於看見彼此。", ending: "相遇結局" },
    "memory-ending": { chapter: "終章", title: "被湖水記住的今晚", text: "小船帶著我們的倒影回到岸邊。湖面從此多了兩個並肩的光點，每當有人經過，都會聽見很輕的笑聲。", ending: "倒影結局" },
  };
  const storyTrail = byId("story-trail");
  const storyChapter = byId("story-chapter");
  const storyTitle = byId("story-title");
  const storyText = byId("story-text");
  const storyChoices = byId("story-choices");
  let storyStep = 0;

  function renderStoryTrail(done = false): void {
    storyTrail.replaceChildren();
    for (let i = 0; i < 4; i += 1) {
      const bar = document.createElement("span");
      if (i < storyStep || done) bar.classList.add("is-done");
      storyTrail.appendChild(bar);
    }
  }

  function renderStory(nodeId: string): void {
    const node = storyNodes[nodeId];
    storyChapter.textContent = node.chapter;
    storyTitle.textContent = node.title;
    storyText.textContent = node.text;
    storyChoices.replaceChildren();
    if (node.ending) {
      byId("round-pill").textContent = node.ending;
      renderStoryTrail(true);
      const again = document.createElement("button");
      again.type = "button";
      again.className = "primary-button";
      again.textContent = "再寫一個故事";
      again.addEventListener("click", startStory);
      storyChoices.appendChild(again);
      deps.setLine("我們一起走到結局了。下次換一條路，也許會遇見完全不同的星光。", "閃閃發光");
      void deps.record("story", "draw");
      return;
    }
    byId("round-pill").textContent = `${storyStep + 1} / 4`;
    renderStoryTrail();
    for (const choice of node.choices ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "story-choice";
      button.textContent = choice.label;
      button.addEventListener("click", () => {
        storyStep += 1;
        deps.setLine(choice.line, "笑一笑");
        window.setTimeout(() => renderStory(choice.next), 360);
      });
      storyChoices.appendChild(button);
    }
  }

  function startStory(): void {
    deps.activate("story", "雙星物語", "共同選擇的故事", "1 / 4");
    storyStep = 0;
    deps.setLine("這次的故事沒有寫好的答案。第一步，就交給你選。", "笑一笑");
    renderStory("start");
  }

  return {
    "rock-paper-scissors": startRps,
    "memory-match": startMemory,
    "connect-four": startConnect,
    "twenty-questions": startTwenty,
    "truth-cards": startTruth,
    story: startStory,
  };
}
