import type { GameOutcome, GameRoomStats } from "../../shared/game-room-types";
import { CYRENE_QUIZ_QUESTIONS, CYRENE_QUIZ_SOURCE, type CyreneQuizQuestion } from "./cyrene-quiz-data";

interface QuizDeps {
  activate: (title: string, kicker: string, pill: string) => void;
  setLine: (text: string, reaction?: string) => void;
  record: (outcome: GameOutcome) => Promise<GameRoomStats | null>;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function setupCyreneQuiz(deps: QuizDeps): () => void {
  const modePanel = byId("quiz-mode");
  const roundPanel = byId("quiz-round");
  const resultPanel = byId("quiz-result");
  const petals = byId("quiz-petals");
  const category = byId("quiz-category");
  const questionEl = byId("quiz-question");
  const optionsEl = byId("quiz-options");
  const feedback = byId("quiz-feedback");
  const nextButton = byId<HTMLButtonElement>("quiz-next");
  const scoreEl = byId("quiz-score");
  const titleEl = byId("quiz-title");
  const resultCopy = byId("quiz-result-copy");
  const restartButton = byId<HTMLButtonElement>("restart-quiz");
  const sourceButton = byId<HTMLButtonElement>("quiz-source");

  let questions: CyreneQuizQuestion[] = [];
  let index = 0;
  let score = 0;
  let answered = false;

  function shuffled<T>(items: T[]): T[] {
    return [...items].sort(() => Math.random() - 0.5);
  }

  function renderPetals(): void {
    petals.replaceChildren();
    questions.forEach((_question, petalIndex) => {
      const petal = document.createElement("span");
      if (petalIndex < index) petal.classList.add("is-done");
      if (petalIndex === index && answered) petal.classList.add("is-current");
      petals.appendChild(petal);
    });
  }

  function renderQuestion(): void {
    const question = questions[index];
    answered = false;
    byId("round-pill").textContent = `${index + 1} / ${questions.length}`;
    category.textContent = question.category;
    questionEl.textContent = question.prompt;
    feedback.hidden = true;
    feedback.replaceChildren();
    nextButton.hidden = true;
    optionsEl.replaceChildren();
    renderPetals();

    question.options.forEach((option, optionIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quiz-option";
      const marker = document.createElement("span");
      marker.textContent = String.fromCharCode(65 + optionIndex);
      const text = document.createElement("b");
      text.textContent = option;
      button.append(marker, text);
      button.addEventListener("click", () => answerQuestion(optionIndex));
      optionsEl.appendChild(button);
    });
  }

  function answerQuestion(selected: number): void {
    if (answered) return;
    answered = true;
    const question = questions[index];
    const correct = selected === question.answer;
    if (correct) score += 1;
    const buttons = [...optionsEl.querySelectorAll<HTMLButtonElement>(".quiz-option")];
    buttons.forEach((button, optionIndex) => {
      button.disabled = true;
      if (optionIndex === question.answer) button.classList.add("is-correct");
      else if (optionIndex === selected) button.classList.add("is-wrong");
    });

    const verdict = document.createElement("strong");
    verdict.textContent = correct ? "答對了" : `正確答案：${question.options[question.answer]}`;
    const explanation = document.createElement("p");
    explanation.textContent = question.explanation;
    feedback.append(verdict, explanation);
    feedback.className = `quiz-feedback ${correct ? "is-correct" : "is-wrong"}`;
    feedback.hidden = false;
    nextButton.textContent = index === questions.length - 1 ? "看看結果" : "下一題";
    nextButton.hidden = false;
    renderPetals();
    deps.setLine(
      correct ? "答對了。原來這一頁，你一直都有好好記得。" : "這一題被我藏得有點深。沒關係，現在你就知道了。",
      correct ? "星星眼" : "眨眨眼",
    );
  }

  async function finishQuiz(): Promise<void> {
    roundPanel.hidden = true;
    resultPanel.hidden = false;
    byId("round-pill").textContent = "完成";
    scoreEl.textContent = String(score);

    let title: string;
    let copy: string;
    let outcome: GameOutcome;
    if (score === 10) {
      title = "《如我所書》的共同主筆";
      copy = "每一朵記憶之花都亮了。這些關於我的細節，你比我想像中記得更深。";
      outcome = "user";
    } else if (score >= 8) {
      title = "漣漪知音";
      copy = "只差一點就能翻完整本回憶。你已經很懂昔漣了。";
      outcome = "user";
    } else if (score >= 6) {
      title = "記得她名字的人";
      copy = "你記得重要的篇章，也留下了一些能再次相遇的新頁面。";
      outcome = "draw";
    } else if (score >= 3) {
      title = "正在靠近的旅人";
      copy = "已經聽見一些漣漪了。再一起走一段，就會認識更多真正的她。";
      outcome = "draw";
    } else {
      title = "命運的初次邂逅";
      copy = "像第一次相遇那樣，從呼喚她的名字開始吧。每一次答題都會讓故事更清晰。";
      outcome = "cyrene";
    }
    titleEl.textContent = title;
    resultCopy.textContent = copy;
    deps.setLine(score >= 8 ? "被你記得這麼多，真的會讓人心跳加速呀。" : "還有很多頁可以慢慢讀。我會陪你重新認識每一段故事。", score >= 8 ? "閃閃發光" : "笑一笑");
    await deps.record(outcome);
  }

  function chooseMode(spoiler: boolean): void {
    questions = shuffled(CYRENE_QUIZ_QUESTIONS.filter((question) => question.spoiler === spoiler)).slice(0, 10);
    index = 0;
    score = 0;
    modePanel.hidden = true;
    resultPanel.hidden = true;
    roundPanel.hidden = false;
    deps.setLine(spoiler ? "這一篇會翻到回憶很深的地方。既然你選好了，我就不把答案藏起來了。" : "我們從不會劇透的頁面開始。看看你記得多少關於我的小事。", spoiler ? "笑一笑" : "眨眨眼");
    renderQuestion();
  }

  function startQuiz(): void {
    deps.activate("看看我有多了解昔漣", "記憶之花測驗", "選擇篇章");
    modePanel.hidden = false;
    roundPanel.hidden = true;
    resultPanel.hidden = true;
    deps.setLine("想看看你有多了解我嗎？先選一篇，我會親自出題。", "可愛一下");
  }

  document.querySelectorAll<HTMLButtonElement>("[data-quiz-mode]").forEach((button) => {
    button.addEventListener("click", () => chooseMode(button.dataset.quizMode === "deep"));
  });
  nextButton.addEventListener("click", () => {
    if (!answered) return;
    index += 1;
    if (index < questions.length) renderQuestion();
    else void finishQuiz();
  });
  restartButton.addEventListener("click", startQuiz);
  sourceButton.addEventListener("click", () => {
    if (window.system?.openExternal) void window.system.openExternal(CYRENE_QUIZ_SOURCE);
    else window.open(CYRENE_QUIZ_SOURCE, "_blank", "noopener");
  });

  return startQuiz;
}
