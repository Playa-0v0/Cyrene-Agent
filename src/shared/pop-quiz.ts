// pop_quiz 抽查测试协议 —— 模型出题、用户作答、主进程判分的完整类型链。
//
// 协议分四层，每层的信任边界不同：
// 1. QuizQuestion*（模型输入）—— 不含任何 id，id 由宿主生成
// 2. PopQuizCard（发给渲染端的卡片）—— 不含任何答案/讲解，防止提交前泄露
// 3. PopQuizSubmission（渲染端回传）—— 只含选项 id 与自由文本
// 4. PopQuizToolResult（回给模型的工具结果）—— 含判分、原始作答、learningObjective

// ── 1. 模型输入：discriminated union 四题型 ────────────────

/** 单选题。correctIndex 指向 options 下标。 */
export interface QuizChoiceInput {
  type: "choice";
  question: string;
  options: string[];
  correctIndex: number;
  learningObjective: string;
  explanation: string;
  sourceRef?: QuizSourceRef;
}

/** 多选题。全对才判对。 */
export interface QuizMultiInput {
  type: "multi";
  question: string;
  options: string[];
  correctIndexes: number[];
  learningObjective: string;
  explanation: string;
  sourceRef?: QuizSourceRef;
}

/** 判断题。 */
export interface QuizTrueFalseInput {
  type: "true_false";
  question: string;
  correct: boolean;
  learningObjective: string;
  explanation: string;
  sourceRef?: QuizSourceRef;
}

/** 简答题。不本地判分，模型看到原文后自行讲评。 */
export interface QuizShortAnswerInput {
  type: "short_answer";
  question: string;
  referenceAnswer: string;
  rubric: string[];
  learningObjective: string;
  explanation: string;
  sourceRef?: QuizSourceRef;
}

export type QuizQuestionInput =
  | QuizChoiceInput
  | QuizMultiInput
  | QuizTrueFalseInput
  | QuizShortAnswerInput;

/** 题目材料出处：模型出题前实际读取过的 vault 材料。 */
export interface QuizSourceRef {
  file: string;
  heading?: string;
}

// ── 2. 渲染端卡片（不含答案） ────────────────────────────────

export type PopQuizQuestionType = "choice" | "multi" | "true_false" | "short_answer";

/** 卡片上的单题视图。选项 id 由宿主生成，渲染端提交时原样回传。 */
export interface PopQuizQuestionView {
  id: string;
  type: PopQuizQuestionType;
  question: string;
  /** choice / multi 的选项；true_false / short_answer 为空。 */
  options: Array<{ id: string; label: string }>;
  /** 本题测的知识点，卡片上展示给用户。 */
  learningObjective: string;
}

/** 主进程 → 渲染端的抽查卡片。不含 correctIndex / correct / referenceAnswer / explanation。 */
export interface PopQuizCard {
  quizId: string;
  runId: string;
  /** 卡片标题副文本，如"复习一下刚才学的内容"。 */
  intro: string;
  questions: PopQuizQuestionView[];
}

// ── 3. 提交协议 ─────────────────────────────────────────────

/** 渲染端单题作答。answer 字段按题型取值：选项 id / id 数组 / boolean / 文本。 */
export interface PopQuizAnswerSubmission {
  questionId: string;
  /** choice：选项 id。 */
  optionId?: string;
  /** multi：选项 id 数组。 */
  optionIds?: string[];
  /** true_false：true / false。 */
  boolean?: boolean;
  /** short_answer：用户原文。 */
  text?: string;
}

export interface PopQuizSubmission {
  quizId: string;
  answers: PopQuizAnswerSubmission[];
}

// ── 4. 判分与工具结果 ───────────────────────────────────────

export type QuizGrading = "correct" | "incorrect" | "pending_model";

/** 单题判分结果。保留原始作答，掌握度提取可以看到"漏选了哪个"级别的证据。 */
export interface QuizAnswerResult {
  questionId: string;
  learningObjective: string;
  userAnswer: string | number | number[] | boolean;
  /** 标准答案；简答题无（pending_model）。 */
  correctAnswer?: string | number | number[] | boolean;
  grading: QuizGrading;
}

/** pop_quiz 的完整工具结果：模型看到的闭合协议。 */
export type PopQuizToolResult =
  | {
      quizId: string;
      status: "submitted";
      answers: QuizAnswerResult[];
    }
  | {
      quizId: string;
      status: "skipped";
    };

/** 判分后发给渲染端的展示态数据：每题对错 + 讲解 + 标准答案。 */
export interface PopQuizGradedQuestion {
  questionId: string;
  grading: QuizGrading;
  /** 主进程本地判分后的标准答案（渲染端展示态高亮用）。 */
  correctAnswer?: string | number | number[] | boolean;
  explanation: string;
}

/** POP_QUIZ_RESOLVE 的返回值：渲染端据此把卡片切到展示态。 */
export interface PopQuizResolveResponse {
  ok: boolean;
  error?: string;
  /** 提交成功时的判分详情。 */
  graded?: PopQuizGradedQuestion[];
}

// ── 5. 结算广播 ─────────────────────────────────────────────

export type PopQuizSettleReason = "submitted" | "skipped" | "cancelled";

/** POP_QUIZ_SETTLED 广播 payload：渲染端据此清卡。 */
export interface PopQuizSettledPayload {
  quizId: string;
  runId?: string;
  reason: PopQuizSettleReason;
}
