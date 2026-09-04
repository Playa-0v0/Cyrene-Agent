// pop_quiz 抽查测试工具 —— learn 模式的掌握度实测闭环。
//
// 数据流：
//   模型调用 pop_quiz（题目 + 知识点 + 答案 + 讲解，无 id）
//     → 宿主生成 quizId / questionId / optionId，建立 pending
//     → 广播 POP_QUIZ_REQUEST 给渲染端（10s 幂等重播，防渲染端丢首次广播）
//     → 用户提交作答 → 主进程本地判分 → 作为 toolResult 回给模型
//     → 用户点「跳过抽查」→ settle skipped，不产生掌握度证据
//
// 不设超时：pending 只能被「用户提交 / 用户跳过 / run 终态清理」结算，
// 与审批流同构（settle 统一入口 + 结算广播 + 渲染端持久监听清卡）。
//
// 信任边界：渲染端卡片 payload 不含任何答案与讲解；
// explanation 与标准答案只在判分完成后随 resolve 返回值下发。

import { BrowserWindow } from "electron";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { createAbortError } from "../abort-utils";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolContext } from "./tools/registry/tool-context";
import type {
  PopQuizCard,
  PopQuizGradedQuestion,
  PopQuizResolveResponse,
  PopQuizSubmission,
  PopQuizToolResult,
  PopQuizSettledPayload,
  QuizAnswerResult,
  QuizQuestionInput,
} from "../../shared/pop-quiz";

const LOG_PREFIX = "[PopQuiz]";

/** 重播间隔：渲染端丢首次广播时，最多等这么久就能等到重播。与审批流一致。 */
const QUIZ_REBROADCAST_INTERVAL_MS = 10_000;

/** 一次抽查的题量上限（与 ask 卡片"最多 3 问"同款约束）。 */
const QUIZ_MAX_QUESTIONS = 3;

// ── 模型输入解析 ───────────────────────────────────────────

function parseSourceRef(value: unknown): { file: string; heading?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  const file = typeof ref.file === "string" ? ref.file.trim() : "";
  if (!file) return undefined;
  const heading = typeof ref.heading === "string" && ref.heading.trim() ? ref.heading.trim() : undefined;
  return heading ? { file, heading } : { file };
}

/** 校验单题公共字段与按题型差异字段，返回规整后的题目或错误信息。 */
function parseQuizQuestion(candidate: unknown, index: number): { question?: QuizQuestionInput; error?: string } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { error: `第 ${index + 1} 题必须是对象` };
  }
  const item = candidate as Record<string, unknown>;
  const question = typeof item.question === "string" ? item.question.trim() : "";
  const learningObjective = typeof item.learningObjective === "string" ? item.learningObjective.trim() : "";
  const explanation = typeof item.explanation === "string" ? item.explanation.trim() : "";
  if (!question) return { error: `第 ${index + 1} 题的 question 不能为空` };
  if (!learningObjective) return { error: `第 ${index + 1} 题必须声明 learningObjective（本题测的知识点）` };
  const sourceRef = parseSourceRef(item.sourceRef);
  const common = { question, learningObjective, explanation, ...(sourceRef ? { sourceRef } : {}) };

  const parseOptions = (): { options?: string[]; error?: string } => {
    if (!Array.isArray(item.options)) return { error: `第 ${index + 1} 题的 options 必须是数组` };
    const options: string[] = [];
    for (const option of item.options) {
      const text = typeof option === "string" ? option.trim() : "";
      if (!text) return { error: `第 ${index + 1} 题的选项不能为空` };
      options.push(text);
    }
    if (options.length < 2 || options.length > 6) {
      return { error: `第 ${index + 1} 题的选项数量必须在 2-6 之间` };
    }
    return { options };
  };

  const isInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

  switch (item.type) {
    case "choice": {
      const { options, error } = parseOptions();
      if (error || !options) return { error };
      if (!isInt(item.correctIndex) || item.correctIndex >= options.length) {
        return { error: `第 ${index + 1} 题 correctIndex 必须是有效选项下标` };
      }
      return { question: { type: "choice", ...common, options, correctIndex: item.correctIndex } };
    }
    case "multi": {
      const { options, error } = parseOptions();
      if (error || !options) return { error };
      if (!Array.isArray(item.correctIndexes) || item.correctIndexes.length === 0) {
        return { error: `第 ${index + 1} 题 correctIndexes 必须是非空数组` };
      }
      const seen = new Set<number>();
      for (const idx of item.correctIndexes) {
        if (!isInt(idx) || idx >= options.length || seen.has(idx)) {
          return { error: `第 ${index + 1} 题 correctIndexes 含无效或重复下标` };
        }
        seen.add(idx);
      }
      return { question: { type: "multi", ...common, options, correctIndexes: [...seen].sort((a, b) => a - b) } };
    }
    case "true_false": {
      if (typeof item.correct !== "boolean") {
        return { error: `第 ${index + 1} 题 correct 必须是 boolean` };
      }
      return { question: { type: "true_false", ...common, correct: item.correct } };
    }
    case "short_answer": {
      const referenceAnswer = typeof item.referenceAnswer === "string" ? item.referenceAnswer.trim() : "";
      if (!referenceAnswer) return { error: `第 ${index + 1} 题必须提供 referenceAnswer 评分参考` };
      if (!Array.isArray(item.rubric)) return { error: `第 ${index + 1} 题的 rubric 必须是数组` };
      const rubric = item.rubric.map((point) => String(point ?? "").trim()).filter(Boolean);
      return { question: { type: "short_answer", ...common, referenceAnswer, rubric } };
    }
    default:
      return { error: `第 ${index + 1} 题 type 必须是 choice / multi / true_false / short_answer` };
  }
}

/** 解析工具入参：1-3 题，逐题校验。 */
export function parseQuizInput(raw: unknown): { questions?: QuizQuestionInput[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > QUIZ_MAX_QUESTIONS) {
    return { error: `questions 必须是包含 1-${QUIZ_MAX_QUESTIONS} 题的数组` };
  }
  const questions: QuizQuestionInput[] = [];
  for (const [index, candidate] of raw.entries()) {
    const parsed = parseQuizQuestion(candidate, index);
    if (parsed.error || !parsed.question) return { error: parsed.error };
    questions.push(parsed.question);
  }
  return { questions };
}

// ── 发布：宿主生成全部 id，答案留主进程 ────────────────────

/** 主进程私有的单题数据：判分与讲解的下发都要靠它。 */
interface PrivateQuizQuestion {
  questionId: string;
  type: QuizQuestionInput["type"];
  learningObjective: string;
  explanation: string;
  /** 选项 id → 下标。choice / multi 用。 */
  optionIndex: Map<string, number>;
  /** choice / multi / true_false 的标准答案（下标/下标数组/boolean）。 */
  correctAnswer?: number | number[] | boolean;
}

/** 主进程私有发布状态：卡片 payload 给渲染端，private 留本地判分。 */
export interface PopQuizPublication {
  card: PopQuizCard;
  privateQuestions: PrivateQuizQuestion[];
}

/** 把模型输入物化为渲染端卡片 + 主进程私有答案。 */
export function buildPopQuizPublication(
  questions: QuizQuestionInput[],
  identity: { runId: string; quizId: string },
): PopQuizPublication {
  const privateQuestions: PrivateQuizQuestion[] = [];
  const views: PopQuizCard["questions"] = questions.map((question, questionIndex) => {
    const questionId = `q${questionIndex + 1}`;
    const optionIndex = new Map<string, number>();
    const options = (question.type === "choice" || question.type === "multi")
      ? question.options.map((label, optionIndexNum) => {
          const id = `${questionId}-opt-${optionIndexNum + 1}`;
          optionIndex.set(id, optionIndexNum);
          return { id, label };
        })
      : [];
    const correctAnswer = question.type === "choice"
      ? question.correctIndex
      : question.type === "multi"
        ? [...question.correctIndexes].sort((a, b) => a - b)
        : question.type === "true_false"
          ? question.correct
          : undefined;
    privateQuestions.push({
      questionId,
      type: question.type,
      learningObjective: question.learningObjective,
      explanation: question.explanation,
      optionIndex,
      ...(correctAnswer !== undefined ? { correctAnswer } : {}),
    });
    return {
      id: questionId,
      type: question.type,
      question: question.question,
      options,
      learningObjective: question.learningObjective,
    };
  });
  return {
    card: {
      quizId: identity.quizId,
      runId: identity.runId,
      intro: "突击抽查：答完这几题，看看刚才的内容掌握了没有。",
      questions: views,
    },
    privateQuestions,
  };
}

// ── 提交校验 + 本地判分 ────────────────────────────────────

/** 校验渲染端提交并本地判分。校验失败返回错误串（pending 保持 open，用户可改后重交）。 */
export function gradeQuizSubmission(
  publication: PopQuizPublication,
  submission: PopQuizSubmission,
): { results?: QuizAnswerResult[]; graded?: PopQuizGradedQuestion[]; error?: string } {
  const byId = new Map(publication.privateQuestions.map((q) => [q.questionId, q]));
  if (!Array.isArray(submission.answers) || submission.answers.length !== publication.privateQuestions.length) {
    return { error: "E_QUIZ_ANSWER_INCOMPLETE" };
  }
  const seen = new Set<string>();
  for (const answer of submission.answers) {
    if (!answer || typeof answer !== "object") return { error: "E_QUIZ_ANSWER_INVALID" };
    const questionId = answer.questionId;
    if (typeof questionId !== "string" || seen.has(questionId)) return { error: "E_QUIZ_ANSWER_INVALID" };
    seen.add(questionId);
    if (!byId.has(questionId)) return { error: "E_QUIZ_ANSWER_INVALID" };
  }

  const results: QuizAnswerResult[] = [];
  const graded: PopQuizGradedQuestion[] = [];
  for (const question of publication.privateQuestions) {
    const answer = submission.answers.find((a) => a.questionId === question.questionId);
    // 每题判分逻辑：choice/multi/true_false 本地判，short_answer 原样打包等模型讲评
    if (question.type === "choice") {
      const optionId = answer?.optionId;
      if (typeof optionId !== "string" || !question.optionIndex.has(optionId)) return { error: "E_QUIZ_ANSWER_INVALID" };
      const selectedIndex = question.optionIndex.get(optionId)!;
      const correct = selectedIndex === question.correctAnswer;
      results.push({
        questionId: question.questionId,
        learningObjective: question.learningObjective,
        userAnswer: selectedIndex,
        correctAnswer: question.correctAnswer,
        grading: correct ? "correct" : "incorrect",
      });
    } else if (question.type === "multi") {
      const optionIds = answer?.optionIds;
      if (!Array.isArray(optionIds) || optionIds.length === 0) return { error: "E_QUIZ_ANSWER_INVALID" };
      const seenOptions = new Set<string>();
      const selectedIndexes: number[] = [];
      for (const optionId of optionIds) {
        if (typeof optionId !== "string" || !question.optionIndex.has(optionId) || seenOptions.has(optionId)) {
          return { error: "E_QUIZ_ANSWER_INVALID" };
        }
        seenOptions.add(optionId);
        selectedIndexes.push(question.optionIndex.get(optionId)!);
      }
      selectedIndexes.sort((a, b) => a - b);
      const expected = question.correctAnswer as number[];
      const correct = selectedIndexes.length === expected.length
        && selectedIndexes.every((value, i) => value === expected[i]);
      results.push({
        questionId: question.questionId,
        learningObjective: question.learningObjective,
        userAnswer: selectedIndexes,
        correctAnswer: expected,
        grading: correct ? "correct" : "incorrect",
      });
    } else if (question.type === "true_false") {
      if (typeof answer?.boolean !== "boolean") return { error: "E_QUIZ_ANSWER_INVALID" };
      const correct = answer.boolean === question.correctAnswer;
      results.push({
        questionId: question.questionId,
        learningObjective: question.learningObjective,
        userAnswer: answer.boolean,
        correctAnswer: question.correctAnswer,
        grading: correct ? "correct" : "incorrect",
      });
    } else {
      const text = answer?.text;
      if (typeof text !== "string" || !text.trim()) return { error: "E_QUIZ_ANSWER_INVALID" };
      results.push({
        questionId: question.questionId,
        learningObjective: question.learningObjective,
        userAnswer: text.trim(),
        grading: "pending_model",
      });
    }
    const lastResult = results[results.length - 1];
    graded.push({
      questionId: question.questionId,
      grading: lastResult.grading,
      ...(lastResult.correctAnswer !== undefined ? { correctAnswer: lastResult.correctAnswer } : {}),
      explanation: question.explanation,
    });
  }
  return { results, graded };
}

// ── pending 管理（无超时 + 10s 重播，照抄审批流） ───────────

interface PendingQuiz {
  publication: PopQuizPublication;
  resolve: (result: PopQuizToolResult) => void;
  reject: (err: Error) => void;
  /** 重播定时器：结算时必须清掉。 */
  rebroadcastTimer: NodeJS.Timeout;
  /** 关联的 canonical runId，用于 run 终态清理。 */
  runId: string;
}

const pendingQuizzes = new Map<string, PendingQuiz>();
let quizCounter = 0;

/** 本轮 run 的作答证据：learn-post-turn 消费（consume-once，skipped 不入账）。 */
const quizEvidenceByRun = new Map<string, QuizAnswerResult[]>();

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/** 取走某 run 攒下的作答证据（一次性消费，取后清空）。 */
export function takeQuizEvidenceForRun(runId: string): QuizAnswerResult[] {
  const evidence = quizEvidenceByRun.get(runId);
  quizEvidenceByRun.delete(runId);
  return evidence ?? [];
}

/**
 * 结算一次 pending 抽查：清重播定时器、从 map 移除、广播结算事件、执行 settle。
 * 所有结算路径（提交 / 跳过 / run 取消）都必须走这里，保证渲染端总能收到通知。
 */
function settlePendingQuiz(
  quizId: string,
  reason: PopQuizSettledPayload["reason"],
  settle: (pending: PendingQuiz) => void,
): void {
  const pending = pendingQuizzes.get(quizId);
  if (!pending) return;
  clearInterval(pending.rebroadcastTimer);
  pendingQuizzes.delete(quizId);
  broadcastToAllWindows(IPC.POP_QUIZ_SETTLED, {
    quizId,
    runId: pending.runId,
    reason,
  } satisfies PopQuizSettledPayload);
  settle(pending);
}

/**
 * 发起一次抽查：发布卡片并阻塞等待用户提交 / 跳过 / run 取消。
 * 无超时；无窗口时直接失败（应用退出中的边缘情况，与审批流一致）。
 */
export function requestPopQuiz(
  questions: QuizQuestionInput[],
  identity: { runId: string },
): Promise<PopQuizToolResult> {
  return new Promise<PopQuizToolResult>((resolve, reject) => {
    if (BrowserWindow.getAllWindows().length === 0) {
      reject(new Error("E_QUIZ_NO_WINDOW"));
      return;
    }
    const quizId = "quiz-" + (++quizCounter) + "-" + Date.now();
    const publication = buildPopQuizPublication(questions, { quizId, runId: identity.runId });

    const rebroadcastTimer = setInterval(() => {
      broadcastToAllWindows(IPC.POP_QUIZ_REQUEST, publication.card);
    }, QUIZ_REBROADCAST_INTERVAL_MS);
    if (typeof rebroadcastTimer.unref === "function") rebroadcastTimer.unref();

    pendingQuizzes.set(quizId, { publication, resolve, reject, rebroadcastTimer, runId: identity.runId });
    console.log(LOG_PREFIX, "发送抽查卡片:", quizId, "题数:", questions.length);
    // 首次广播给所有窗口（渲染端同 quizId 覆盖，重播无副作用）
    broadcastToAllWindows(IPC.POP_QUIZ_REQUEST, publication.card);
  });
}

// ── IPC 注册 ───────────────────────────────────────────────

/** 注册 pop_quiz IPC handler（bootstrap 启动时调一次）。 */
export function registerPopQuizIpc(ipcOption?: IpcScope): void {
  const ipc = ipcOption ?? createIpcScope();

  // 渲染端提交作答：校验 + 本地判分 + settle submitted。
  // 返回值带判分详情，渲染端据此把卡片切到展示态（高亮对错 + 显示讲解）。
  ipc.handle(IPC.POP_QUIZ_RESOLVE, (_event, submission: unknown): PopQuizResolveResponse => {
    const payload = submission as PopQuizSubmission | null;
    const quizId = payload && typeof payload.quizId === "string" ? payload.quizId : "";
    const pending = quizId ? pendingQuizzes.get(quizId) : undefined;
    if (!pending || !payload) {
      console.warn(LOG_PREFIX, "抽查提交未匹配到 pending:", quizId || "(无 quizId)");
      return { ok: false, error: "E_QUIZ_NOT_FOUND" };
    }
    const gradedResult = gradeQuizSubmission(pending.publication, payload);
    if (gradedResult.error || !gradedResult.results || !gradedResult.graded) {
      // 校验失败：pending 保持 open，渲染端提示后用户可修改重交
      console.warn(LOG_PREFIX, "抽查提交校验失败:", gradedResult.error);
      return { ok: false, error: gradedResult.error ?? "E_QUIZ_ANSWER_INVALID" };
    }
    const results = gradedResult.results;
    settlePendingQuiz(quizId, "submitted", (p) => {
      // 作答证据入账：learn-post-turn 据此把掌握度从"对话推断"升级为"实测数据"
      const existing = quizEvidenceByRun.get(p.runId) ?? [];
      existing.push(...results);
      quizEvidenceByRun.set(p.runId, existing);
      p.resolve({ quizId, status: "submitted", answers: results });
    });
    return { ok: true, graded: gradedResult.graded };
  });

  // 渲染端点「跳过抽查」：整次 quiz 一次跳掉，不产生掌握度证据。
  ipc.handle(IPC.POP_QUIZ_SKIP, (_event, payload: { quizId?: string }) => {
    const quizId = typeof payload?.quizId === "string" ? payload.quizId : "";
    const pending = pendingQuizzes.get(quizId);
    if (!pending) return { ok: false, error: "E_QUIZ_NOT_FOUND" };
    settlePendingQuiz(quizId, "skipped", (p) => p.resolve({ quizId, status: "skipped" }));
    return { ok: true };
  });
}

/**
 * 取消指定 runId 关联的所有 pending 抽查。
 * run 终态（complete / error / cancel）路径调用，防止工具 promise 永久悬挂。
 */
export function cancelPendingQuizzesForRun(runId: string): void {
  for (const [quizId, pending] of [...pendingQuizzes]) {
    if (pending.runId === runId) {
      settlePendingQuiz(quizId, "cancelled", (p) => p.reject(createAbortError()));
      console.log(LOG_PREFIX, "cancelPendingQuizzesForRun 清理:", quizId, "runId=", runId);
    }
  }
}

// ── 工具注册 ───────────────────────────────────────────────

/** 工具说明里的题型填写指引：让模型一看就知道每种题型怎么填、答案和讲解都要给。 */
function quizQuestionSchemaDescription(): string {
  return [
    "单选题：type=\"choice\"，options 2-6 项，correctIndex 指向正确项下标",
    "多选题：type=\"multi\"，correctIndexes 数组（全对才对）",
    "判断题：type=\"true_false\"，correct 为 true/false",
    "简答题：type=\"short_answer\"，referenceAnswer 评分参考 + rubric 给分要点数组",
  ].join("；");
}

export const POP_QUIZ_TOOL_ID = "pop_quiz";

export const popQuizTool: ToolDefinition = {
  id: POP_QUIZ_TOOL_ID,
  name: "突击抽查",
  description:
    "测试**用户**对已学内容的掌握：出 1-3 道题，等用户作答后拿回判分结果，再针对性讲解错因。\n" +
    "何时用：讲完一个知识点后想确认用户真的懂了；学习进度显示某知识点薄弱需要验证。\n" +
    "不要用：向用户征求偏好、确认或补充信息（那是 ask_user 的职责，两者方向相反：pop_quiz 是你考用户，ask_user 是你问用户）。出题测试用户时必须用本工具，不要用 ask_user。\n" +
    "题目要求：每题必须带 learningObjective（本题测的知识点，优先复用 outline/progress 里已有命名）、explanation（标准答案为什么对，批改后展示给用户）；对 vault 材料中的事实出题时必须先用 obsidian 工具读取材料再出题，sourceRef 只引用本轮实际读取过的材料。\n" +
    "题型：" + quizQuestionSchemaDescription() + "。\n" +
    "结果：选择/判断题由系统本地判分；简答题返回用户原文（grading=pending_model），由你自行批改讲评。用户也可以跳过整次抽查（status=skipped，不算答错）。",
  enabled: true,
  modes: ["learn"],
  needsContext: true,
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "1-3 道题的数组",
        items: { type: "object", description: "题目结构见工具说明" },
      },
    },
    required: ["questions"],
  },
  execute: async (args, ctx?: ToolContext): Promise<string> => {
    const parsed = parseQuizInput(args.questions);
    if (!parsed.questions) {
      throw Object.assign(new Error("pop_quiz 参数无效：" + parsed.error), { code: "E_QUIZ_INPUT_INVALID" });
    }
    const runId = ctx?.runId;
    if (!runId) {
      throw Object.assign(new Error("pop_quiz 需要 run 上下文"), { code: "E_QUIZ_NO_RUN_CONTEXT" });
    }
    const result = await requestPopQuiz(parsed.questions, { runId });
    return JSON.stringify(result);
  },
};

/** 注册 pop_quiz 工具（learn 模式可见）。 */
export function registerPopQuizTool(): void {
  toolRegistry.register(popQuizTool);
}
