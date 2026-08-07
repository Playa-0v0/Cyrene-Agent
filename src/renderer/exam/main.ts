interface MCQ {
  question: string;
  options: string[];
  answer: number;
  explanation: string;
}

let currentQuiz: MCQ[] = [];
let currentQuestionIndex = 0;
let userAnswers: number[] = [];
let correctCount = 0;
let startTime = 0;
let timerInterval: number | null = null;
let selectedQuestionCount = 3;
let selectedReasoning = "auto";
let currentSubject = "AP Physics 1";

// DOM Elements
const viewSetup = document.getElementById("view-setup")!;
const viewLoading = document.getElementById("view-loading")!;
const viewQuiz = document.getElementById("view-quiz")!;
const viewResult = document.getElementById("view-result")!;

const subjectSelect = document.getElementById("subject-select") as HTMLSelectElement;
const customSubjectGroup = document.getElementById("custom-subject-group")!;
const customSubjectInput = document.getElementById("custom-subject-input") as HTMLInputElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

const loadingProgressBar = document.getElementById("loading-progress")!;
const loadingLog = document.getElementById("loading-log")!;

const quizProgressBar = document.getElementById("quiz-progress-bar")!;
const quizProgressText = document.getElementById("quiz-progress-text")!;
const quizTimerText = document.getElementById("quiz-timer-text")!;
const quizQuestionText = document.getElementById("quiz-question-text")!;
const quizOptionsList = document.getElementById("quiz-options-list")!;
const quizFeedback = document.getElementById("quiz-feedback")!;
const feedbackStatusTitle = document.getElementById("feedback-status-title")!;
const feedbackExplanationText = document.getElementById("feedback-explanation-text")!;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;

const resultScoreOverlayText = document.getElementById("result-score-overlay-text")!;
const resultSvgProgressBar = document.getElementById("result-svg-progress-bar") as any;
const resultCommentText = document.getElementById("result-comment-text")!;
const resultTotalQuestions = document.getElementById("result-total-questions")!;
const resultCorrectCount = document.getElementById("result-correct-count")!;
const resultTotalTime = document.getElementById("result-total-time")!;
const reviewSection = document.getElementById("review-section")!;
const reviewList = document.getElementById("review-list")!;
const saveNotebookBtn = document.getElementById("save-notebook-btn") as HTMLButtonElement;
const restartBtn = document.getElementById("restart-btn") as HTMLButtonElement;

// Helper to switch views
function showView(view: HTMLElement) {
  [viewSetup, viewLoading, viewQuiz, viewResult].forEach(v => {
    v.classList.add("is-hidden");
  });
  view.classList.remove("is-hidden");
}

// Subject Change handler
subjectSelect.addEventListener("change", () => {
  if (subjectSelect.value === "custom") {
    customSubjectGroup.classList.remove("is-hidden");
  } else {
    customSubjectGroup.classList.add("is-hidden");
  }
});

// Setup active pill state handlers
function setupPillGroup(containerId: string, callback: (val: string) => void) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const pills = container.querySelectorAll(".pill-btn");
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("is-active"));
      pill.classList.add("is-active");
      const val = pill.getAttribute("data-count") || pill.getAttribute("data-strength") || "";
      callback(val);
    });
  });
}

setupPillGroup("view-setup", (val) => {
  if (val === "3" || val === "5" || val === "10") {
    selectedQuestionCount = parseInt(val, 10);
  }
});

const reasoningStrengthGroup = document.getElementById("reasoning-strength-group");
if (reasoningStrengthGroup) {
  const pills = reasoningStrengthGroup.querySelectorAll(".pill-btn");
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("is-active"));
      pill.classList.add("is-active");
      selectedReasoning = pill.getAttribute("data-strength") || "auto";
    });
  });
}

// JSON Extractor & Sanitizer
function cleanJsonString(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, "");
    cleaned = cleaned.replace(/\n```$/, "");
  }
  return cleaned.trim();
}

function extractJsonArray(str: string): string {
  const start = str.indexOf("[");
  const end = str.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    return str.slice(start, end + 1);
  }
  return str;
}

// Timer Logic
function startTimer() {
  startTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = window.setInterval(() => {
    const elapsed = Date.now() - startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    quizTimerText.textContent = `⏱️ 用時: ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }, 1000);
}

function stopTimer(): string {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Generate Questions via AGUI API
async function generateQuiz() {
  showView(viewLoading);
  loadingProgressBar.style.width = "10%";
  loadingLog.textContent = "正在連線至昔漣的大腦，準備題目中...";

  let subject = subjectSelect.value;
  if (subject === "custom") {
    subject = customSubjectInput.value.trim() || "AP Physics";
  }
  currentSubject = subject;

  const prompt = `你現在是崩壞星穹鐵道的「昔漣」，這是一個考試系統。
請幫我出一套關於「${subject}」的單選題（MCQs），共 ${selectedQuestionCount} 題。
你必須輸出一個符合以下 JSON 格式的數據結構（只輸出 JSON Array，不要包含 Markdown 區塊或額外贅字，否則系統解析會出錯）：
[
  {
    "question": "題目描述",
    "options": ["選項 A", "選項 B", "選項 C", "選項 D"],
    "answer": 0, // 正確答案的索引（0-3，對應 A-D）
    "explanation": "對這題的詳細解析，請用昔漣溫柔體貼的語氣和人設來寫，親切地稱呼我為夥伴。"
  }
]`;

  let accumulatedResponse = "";
  loadingProgressBar.style.width = "30%";
  loadingLog.textContent = "大腦開始生成題目...";

  return new Promise<void>((resolve, reject) => {
    const offEvent = window.agui!.onEvent((rawEvent: any) => {
      if (rawEvent.type === "TEXT_MESSAGE_CONTENT" && rawEvent.delta) {
        accumulatedResponse += rawEvent.delta;
        loadingProgressBar.style.width = "60%";
        loadingLog.textContent = "題目產生中，請稍候...";
      }
    });

    window.agui!.run({
      messages: [{ role: "user", content: prompt }],
      style: selectedReasoning === "high" ? "04_focused.md" : "01_default.md"
    }).then((res) => {
      offEvent();
      if (!res.success) {
        reject(new Error(res.error || "出題失敗"));
        return;
      }
      loadingProgressBar.style.width = "90%";
      loadingLog.textContent = "正在解析題目資料...";
      try {
        const jsonText = extractJsonArray(cleanJsonString(accumulatedResponse));
        const parsed = JSON.parse(jsonText) as MCQ[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          currentQuiz = parsed;
          resolve();
        } else {
          reject(new Error("產生的題目格式不正確，請再試一次。"));
        }
      } catch (err) {
        console.error("JSON parse error on:", accumulatedResponse);
        reject(new Error("解析題目 JSON 失敗，請重試。"));
      }
    }).catch(err => {
      offEvent();
      reject(err);
    });
  });
}

// Start Quiz Challenge
startBtn.addEventListener("click", async () => {
  if (subjectSelect.value === "custom" && !customSubjectInput.value.trim()) {
    alert("請輸入您要測試的自定義主題喔！");
    return;
  }
  startBtn.disabled = true;
  try {
    await generateQuiz();
    startBtn.disabled = false;
    currentQuestionIndex = 0;
    userAnswers = new Array(currentQuiz.length).fill(-1);
    correctCount = 0;
    showView(viewQuiz);
    startTimer();
    renderQuestion();
  } catch (err: any) {
    startBtn.disabled = false;
    showView(viewSetup);
    alert("出題失敗囉：" + err.message);
  }
});

// Render current question
function renderQuestion() {
  quizFeedback.classList.add("is-hidden");
  const q = currentQuiz[currentQuestionIndex];
  
  // Update progress bar
  const progressPercent = (currentQuestionIndex / currentQuiz.length) * 100;
  quizProgressBar.style.width = `${progressPercent}%`;
  
  quizProgressText.textContent = `問題 ${currentQuestionIndex + 1} / ${currentQuiz.length}`;
  quizQuestionText.textContent = q.question;

  quizOptionsList.innerHTML = "";
  const prefixes = ["A", "B", "C", "D"];
  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.innerHTML = `<span class="option-circle">${prefixes[idx]}</span><span class="option-text">${opt}</span>`;
    btn.addEventListener("click", () => handleSelectOption(idx));
    quizOptionsList.appendChild(btn);
  });
}

// Handle answer selection
function handleSelectOption(selectedIndex: number) {
  const buttons = quizOptionsList.querySelectorAll(".option-btn");
  buttons.forEach((btn, idx) => {
    btn.classList.add("is-disabled");
    (btn as HTMLButtonElement).disabled = true;
  });

  const q = currentQuiz[currentQuestionIndex];
  userAnswers[currentQuestionIndex] = selectedIndex;

  const isCorrect = selectedIndex === q.answer;
  if (isCorrect) {
    correctCount++;
    buttons[selectedIndex].classList.add("is-correct");
    feedbackStatusTitle.textContent = "✅ 答對了！你太優秀了！";
    feedbackStatusTitle.className = "feedback-status text-success";
  } else {
    buttons[selectedIndex].classList.add("is-incorrect");
    buttons[q.answer].classList.remove("is-disabled");
    buttons[q.answer].classList.add("is-correct");
    feedbackStatusTitle.textContent = `❌ 答錯了喔... 正確答案是 ${["A", "B", "C", "D"][q.answer]}`;
    feedbackStatusTitle.className = "feedback-status text-danger";
  }

  feedbackExplanationText.textContent = q.explanation;
  quizFeedback.classList.remove("is-hidden");
  
  // Fill progress bar fully if it's the last question
  const isLastQuestion = currentQuestionIndex === currentQuiz.length - 1;
  if (isLastQuestion) {
    quizProgressBar.style.width = "100%";
  }
}

// Handle next button
nextBtn.addEventListener("click", () => {
  currentQuestionIndex++;
  if (currentQuestionIndex < currentQuiz.length) {
    renderQuestion();
  } else {
    finishQuiz();
  }
});

// Finish Quiz & Show Results
async function finishQuiz() {
  const totalTimeStr = stopTimer();
  showView(viewResult);

  const percent = Math.round((correctCount / currentQuiz.length) * 100);
  resultScoreOverlayText.textContent = `${percent}%`;
  
  if (resultSvgProgressBar) {
    resultSvgProgressBar.setAttribute("stroke-dasharray", `${percent}, 100`);
  }
  
  resultTotalQuestions.textContent = `${currentQuiz.length} 題`;
  resultCorrectCount.textContent = `${correctCount} 題`;
  resultTotalTime.textContent = totalTimeStr;

  if (percent >= 80) {
    resultCorrectCount.className = "summary-val text-success";
  } else if (percent >= 60) {
    resultCorrectCount.className = "summary-val text-success";
  } else {
    resultCorrectCount.className = "summary-val text-danger";
  }

  // Render review list
  reviewList.innerHTML = "";
  let hasIncorrect = false;
  currentQuiz.forEach((q, idx) => {
    if (userAnswers[idx] !== q.answer) {
      hasIncorrect = true;
      const item = document.createElement("div");
      item.className = "review-item";
      item.innerHTML = `
        <div class="review-question">第 ${idx + 1} 題：${q.question}</div>
        <div class="review-answers">
          你的回答：<span class="text-danger">${q.options[userAnswers[idx]] || "未答"}</span><br>
          正確答案：<span class="text-success">${q.options[q.answer]}</span>
        </div>
        <div class="review-explanation">昔漣解析：${q.explanation}</div>
      `;
      reviewList.appendChild(item);
    }
  });

  if (hasIncorrect) {
    reviewSection.classList.remove("is-hidden");
  } else {
    reviewSection.classList.add("is-hidden");
  }

  // Get Custom評語 from Cyrene
  resultCommentText.textContent = "昔漣正在寫評語中... 🌸";
  const commentPrompt = `夥伴完成了關於「${currentSubject}」的 AP 物理/學科考試。
考試總題數是 ${currentQuiz.length} 題，夥伴答對了 ${correctCount} 題，得分是 ${percent}%，總共用時 ${totalTimeStr}。
請用你（昔漣）溫柔、體貼、活潑的人設寫一段 60 字左右的評語，親切地稱呼我為夥伴，對我的表現給予肯定、打氣或溫柔的安慰。不需要任何 markdown 格式，只輸出你的說話內容。`;

  let comment = "";
  try {
    const offEvent = window.agui!.onEvent((rawEvent: any) => {
      if (rawEvent.type === "TEXT_MESSAGE_CONTENT" && rawEvent.delta) {
        comment += rawEvent.delta;
        resultCommentText.textContent = comment;
      }
    });

    await window.agui!.run({
      messages: [{ role: "user", content: commentPrompt }],
      style: "01_default.md"
    });
    offEvent();
  } catch (err) {
    console.error("Failed to get custom comment:", err);
    resultCommentText.textContent = percent >= 80 
      ? "夥伴太厲害了！昔漣為你感到無比驕傲喔！物理和動力學這麼難，你卻能拿到這麼高的分數，真的好棒呀～💕" 
      : "物理真的有點吃力呢，但夥伴能堅持寫完真的已經很努力、很棒了喔！昔漣會一直陪著你，我們一起把不會的題目弄懂就好啦，加油！🌸";
  }
}

// Restart Quiz
restartBtn.addEventListener("click", () => {
  showView(viewSetup);
});

// Save to Notebook using agentic prompt
saveNotebookBtn.addEventListener("click", async () => {
  saveNotebookBtn.disabled = true;
  saveNotebookBtn.textContent = "正在存入中...";

  const percent = Math.round((correctCount / currentQuiz.length) * 100);
  const timeStr = resultTotalTime.textContent || "00:00";

  const savePrompt = `請將我剛才的考試成績記錄在如我所書（共享筆記本）中（/Users/clark/cy/Shared Notebook.md）。
這是我的考試資料：
- 科目：${currentSubject}
- 題數：${currentQuiz.length} 題
- 得分：${percent}% (答對 ${correctCount} 題)
- 用時：${timeStr}

請調用你的工具將這筆紀錄以溫柔活潑的口吻新增在筆記本的「📅 成長足跡與共同日誌」章節的最後面。
記錄完成後，請用你昔漣的身份回覆我「已經幫你記在我們的筆記本囉！夥伴真的太棒了～🌸」`;

  try {
    await window.agui!.run({
      messages: [{ role: "user", content: savePrompt }],
      style: "01_default.md"
    });
    saveNotebookBtn.textContent = "✅ 成功存入筆記本！";
  } catch (err: any) {
    console.error("Failed to save notebook:", err);
    saveNotebookBtn.textContent = "❌ 存入失敗，重試";
    saveNotebookBtn.disabled = false;
    alert("存入失敗：" + err.message);
  }
});
