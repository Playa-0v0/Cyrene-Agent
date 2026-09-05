import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handle, send } = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => [{ webContents: { send } }]) },
  ipcMain: { handle },
}));

import {
  buildPopQuizPublication,
  cancelPendingQuizzesForRun,
  gradeQuizSubmission,
  parseQuizInput,
  registerPopQuizIpc,
  requestPopQuiz,
  takeQuizEvidenceForRun,
} from "./pop-quiz";
import { IPC } from "../../shared/ipc-channels";
import type { PopQuizSubmission } from "../../shared/pop-quiz";
import { isAbortError } from "../abort-utils";

/** 一道规整的单选题（判分与发布测试的公共样例）。 */
function sampleChoice() {
  return {
    type: "choice" as const,
    question: "true + true 的结果是什么？",
    options: ["2", "true", "1"],
    correctIndex: 0,
    learningObjective: "JavaScript 中 + 对 boolean 的隐式类型转换",
    explanation: "加号运算符会把 boolean 转成数字再相加，true 转成 1。",
  };
}

/** 从广播记录里捞出最近一张抽查卡片。 */
function lastQuizCard() {
  const call = send.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_REQUEST).at(-1);
  return call?.[1] as ReturnType<typeof buildPopQuizPublication>["card"];
}

/** 从 handle 注册记录里按通道名取 handler。 */
function ipcHandler(channel: string) {
  const call = handle.mock.calls.find(([name]) => name === channel);
  return call?.[1] as (event: unknown, payload: unknown) => unknown;
}

beforeEach(() => {
  handle.mockClear();
  send.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseQuizInput", () => {
  it("接受四种题型的合法输入", () => {
    const parsed = parseQuizInput([
      sampleChoice(),
      {
        type: "multi",
        question: "下列哪些是 JavaScript 的原始类型？",
        options: ["string", "object", "number"],
        correctIndexes: [0, 2],
        learningObjective: "JavaScript 原始类型",
        explanation: "object 不是原始类型。",
      },
      {
        type: "true_false",
        question: "=== 会做隐式类型转换。",
        correct: false,
        learningObjective: "严格相等与宽松相等",
        explanation: "=== 不做类型转换，== 才会。",
      },
    ]);
    expect(parsed.questions).toHaveLength(3);
    expect(parsed.error).toBeUndefined();
  });

  it("拒绝空数组与超过 3 题", () => {
    expect(parseQuizInput([]).error).toBeTruthy();
    const many = Array.from({ length: 4 }, () => sampleChoice());
    expect(parseQuizInput(many).error).toBeTruthy();
  });

  it("拒绝缺失 learningObjective 的题（掌握度闭环的关键契约）", () => {
    const noObjective = { ...sampleChoice(), learningObjective: "  " };
    expect(parseQuizInput([noObjective]).error).toContain("learningObjective");
  });

  it("拒绝越界的 correctIndex", () => {
    const badIndex = { ...sampleChoice(), correctIndex: 5 };
    expect(parseQuizInput([badIndex]).error).toContain("correctIndex");
  });

  it("拒绝少于 2 个选项的选择题", () => {
    const fewOptions = { ...sampleChoice(), options: ["只有一项"], correctIndex: 0 };
    expect(parseQuizInput([fewOptions]).error).toContain("选项数量");
  });

  it("简答题必须有 referenceAnswer", () => {
    const noRef = {
      type: "short_answer",
      question: "用自己的话解释闭包",
      referenceAnswer: "",
      rubric: [],
      learningObjective: "闭包",
      explanation: "",
    };
    expect(parseQuizInput([noRef]).error).toContain("referenceAnswer");
  });

  it("sourceRef 缺 file 时整体忽略该字段", () => {
    const withBadRef = { ...sampleChoice(), sourceRef: { heading: "只有标题" } };
    const parsed = parseQuizInput([withBadRef]);
    expect(parsed.questions?.[0].sourceRef).toBeUndefined();
  });

  // 模型实际调用时的常见格式偏差：沿用 ask_user 的对象选项、字符串下标、字符串 boolean、
  // 单条字符串 rubric。解析层统一规整，避免模型反复试错。
  describe("格式容错（模型实际输出偏差）", () => {
    it("对象选项（ask_user 习惯的 {label}/{text}/{value}）规整为纯文本", () => {
      const withObjectOptions = {
        ...sampleChoice(),
        options: [{ label: "2" }, { text: "true" }, { value: "1" }],
      };
      const parsed = parseQuizInput([withObjectOptions]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.questions?.[0]).toMatchObject({
        type: "choice",
        options: ["2", "true", "1"],
        correctIndex: 0,
      });
    });

    it("字符串下标（correctIndex: \"0\"）规整为数字", () => {
      const withStringIndex = { ...sampleChoice(), correctIndex: "0" };
      const parsed = parseQuizInput([withStringIndex]);
      expect(parsed.questions?.[0]).toMatchObject({ correctIndex: 0 });
    });

    it("multi 的字符串下标数组同样规整", () => {
      const multi = {
        type: "multi" as const,
        question: "下列哪些是原始类型？",
        options: ["string", "object", "number"],
        correctIndexes: ["0", "2"],
        learningObjective: "原始类型",
        explanation: "object 不是。",
      };
      const parsed = parseQuizInput([multi]);
      expect(parsed.questions?.[0]).toMatchObject({ correctIndexes: [0, 2] });
    });

    it("true_false 的字符串 boolean（\"true\"/\"false\"）规整为 boolean", () => {
      const withStringRef = {
        type: "true_false" as const,
        question: "=== 会做隐式类型转换。",
        correct: "false",
        learningObjective: "严格相等",
        explanation: "=== 不转换。",
      };
      const parsed = parseQuizInput([withStringRef]);
      expect(parsed.questions?.[0]).toMatchObject({ correct: false });
    });

    it("short_answer 的单条字符串 rubric 包成数组", () => {
      const shortAnswer = {
        type: "short_answer" as const,
        question: "解释闭包",
        referenceAnswer: "函数与其词法环境的组合",
        rubric: "提到词法环境即可",
        learningObjective: "闭包",
        explanation: "闭包 = 函数 + 词法作用域。",
      };
      const parsed = parseQuizInput([shortAnswer]);
      expect(parsed.questions?.[0]).toMatchObject({ rubric: ["提到词法环境即可"] });
    });

    it("选项对象数组也带不出空文本时，报错明确指出要纯文本数组", () => {
      const badObjectOptions = {
        ...sampleChoice(),
        options: [{ label: "2" }, { unrelated: true }, "1"],
      };
      const parsed = parseQuizInput([badObjectOptions]);
      expect(parsed.error).toContain("纯文本数组");
    });
  });
});

describe("buildPopQuizPublication", () => {
  it("卡片不含任何答案与讲解，私有侧保留判分所需全部数据", () => {
    const publication = buildPopQuizPublication(
      [sampleChoice()],
      { quizId: "quiz-1", runId: "run-1" },
    );
    const cardJson = JSON.stringify(publication.card);
    expect(cardJson).not.toContain("correctIndex");
    expect(cardJson).not.toContain("explanation");
    expect(publication.card.questions[0]).toMatchObject({
      id: "q1",
      type: "choice",
      learningObjective: "JavaScript 中 + 对 boolean 的隐式类型转换",
    });
    expect(publication.card.questions[0].options).toHaveLength(3);
    expect(publication.privateQuestions[0].correctAnswer).toBe(0);
    expect(publication.privateQuestions[0].optionIndex.get("q1-opt-1")).toBe(0);
  });
});

describe("gradeQuizSubmission", () => {
  const publication = buildPopQuizPublication(
    [
      sampleChoice(),
      {
        type: "true_false",
        question: "=== 会做隐式类型转换。",
        correct: false,
        learningObjective: "严格相等与宽松相等",
        explanation: "=== 不做类型转换。",
      },
    ],
    { quizId: "quiz-1", runId: "run-1" },
  );

  it("choice 答对判 correct，答错判 incorrect 并保留原始作答", () => {
    const submission: PopQuizSubmission = {
      quizId: "quiz-1",
      answers: [
        { questionId: "q1", optionId: "q1-opt-1" },
        { questionId: "q2", boolean: false },
      ],
    };
    const graded = gradeQuizSubmission(publication, submission);
    expect(graded.results?.[0]).toMatchObject({ grading: "correct", userAnswer: 0, correctAnswer: 0 });
    expect(graded.graded?.[0].explanation).toContain("加号运算符");
  });

  it("true_false 答错判 incorrect", () => {
    const submission: PopQuizSubmission = {
      quizId: "quiz-1",
      answers: [
        { questionId: "q1", optionId: "q1-opt-1" },
        { questionId: "q2", boolean: true },
      ],
    };
    const graded = gradeQuizSubmission(publication, submission);
    expect(graded.results?.[1]).toMatchObject({ grading: "incorrect", userAnswer: true, correctAnswer: false });
  });

  it("multi 全对才判 correct，漏选判 incorrect（保留选中证据）", () => {
    const multiPub = buildPopQuizPublication(
      [{
        type: "multi",
        question: "哪些是原始类型？",
        options: ["string", "object", "number"],
        correctIndexes: [0, 2],
        learningObjective: "原始类型",
        explanation: "object 不是原始类型。",
      }],
      { quizId: "quiz-m", runId: "run-1" },
    );
    const partial = gradeQuizSubmission(multiPub, {
      quizId: "quiz-m",
      answers: [{ questionId: "q1", optionIds: ["q1-opt-1"] }],
    });
    expect(partial.results?.[0]).toMatchObject({ grading: "incorrect", userAnswer: [0], correctAnswer: [0, 2] });

    const all = gradeQuizSubmission(multiPub, {
      quizId: "quiz-m",
      answers: [{ questionId: "q1", optionIds: ["q1-opt-3", "q1-opt-1"] }],
    });
    expect(all.results?.[0]).toMatchObject({ grading: "correct", userAnswer: [0, 2] });
  });

  it("short_answer 原样打包为 pending_model，不带对错", () => {
    const shortPub = buildPopQuizPublication(
      [{
        type: "short_answer",
        question: "解释闭包",
        referenceAnswer: "函数 + 其词法作用域",
        rubric: ["提到函数", "提到作用域"],
        learningObjective: "闭包",
        explanation: "闭包 = 函数捕获其词法作用域。",
      }],
      { quizId: "quiz-s", runId: "run-1" },
    );
    const graded = gradeQuizSubmission(shortPub, {
      quizId: "quiz-s",
      answers: [{ questionId: "q1", text: " 函数记住它出生时的变量 " }],
    });
    expect(graded.results?.[0]).toMatchObject({
      grading: "pending_model",
      userAnswer: "函数记住它出生时的变量",
    });
    expect(graded.results?.[0].correctAnswer).toBeUndefined();
  });

  it("缺题、重复题、非法选项 id 都拒绝", () => {
    expect(gradeQuizSubmission(publication, {
      quizId: "quiz-1",
      answers: [{ questionId: "q1", optionId: "q1-opt-1" }],
    }).error).toBe("E_QUIZ_ANSWER_INCOMPLETE");
    expect(gradeQuizSubmission(publication, {
      quizId: "quiz-1",
      answers: [
        { questionId: "q1", optionId: "q1-opt-9" },
        { questionId: "q2", boolean: true },
      ],
    }).error).toBeTruthy();
    expect(gradeQuizSubmission(publication, {
      quizId: "quiz-1",
      answers: [
        { questionId: "q1", optionId: "q1-opt-1" },
        { questionId: "q1", optionId: "q1-opt-2" },
      ],
    }).error).toBeTruthy();
  });
});

describe("requestPopQuiz 端到端（IPC 往返）", () => {
  beforeEach(() => {
    registerPopQuizIpc();
  });

  it("提交作答：本地判分 → resolve 返回判分详情 → 工具结果带 learningObjective", async () => {
    const pending = requestPopQuiz([sampleChoice()], { runId: "run-e2e" });
    const card = lastQuizCard();
    expect(card.runId).toBe("run-e2e");
    expect(card.questions[0].options).toHaveLength(3);

    const response = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, {
      quizId: card.quizId,
      answers: [{ questionId: "q1", optionId: "q1-opt-1" }],
    }) as { ok: boolean; graded?: Array<{ grading: string }> };
    expect(response.ok).toBe(true);
    expect(response.graded?.[0].grading).toBe("correct");

    await expect(pending).resolves.toMatchObject({
      quizId: card.quizId,
      status: "submitted",
      answers: [{ questionId: "q1", grading: "correct", learningObjective: expect.any(String) }],
    });

    // 结算广播已发出（渲染端据此清卡）
    const settled = send.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_SETTLED).at(-1);
    expect(settled?.[1]).toMatchObject({ quizId: card.quizId, runId: "run-e2e", reason: "submitted" });

    // 作答证据已入账，consume-once
    const evidence = takeQuizEvidenceForRun("run-e2e");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].learningObjective).toContain("隐式类型转换");
    expect(takeQuizEvidenceForRun("run-e2e")).toHaveLength(0);
  });

  it("跳过抽查：settle skipped，不产生掌握度证据", async () => {
    const pending = requestPopQuiz([sampleChoice()], { runId: "run-skip" });
    const card = lastQuizCard();
    const response = ipcHandler(IPC.POP_QUIZ_SKIP)({}, { quizId: card.quizId }) as { ok: boolean };
    expect(response.ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ quizId: card.quizId, status: "skipped" });
    expect(takeQuizEvidenceForRun("run-skip")).toHaveLength(0);
    const settled = send.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_SETTLED).at(-1);
    expect(settled?.[1]).toMatchObject({ reason: "skipped" });
  });

  it("重复提交只接受第一次（幂等）", async () => {
    const pending = requestPopQuiz([sampleChoice()], { runId: "run-idem" });
    const card = lastQuizCard();
    const first = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, {
      quizId: card.quizId,
      answers: [{ questionId: "q1", optionId: "q1-opt-1" }],
    });
    const second = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, {
      quizId: card.quizId,
      answers: [{ questionId: "q1", optionId: "q1-opt-2" }],
    });
    expect((first as { ok: boolean }).ok).toBe(true);
    expect((second as { ok: boolean; error: string }).ok).toBe(false);
    await expect(pending).resolves.toMatchObject({
      answers: [{ grading: "correct" }],
    });
  });

  it("提交校验失败时 pending 保持 open，可修改后重交", async () => {
    const pending = requestPopQuiz([sampleChoice()], { runId: "run-retry" });
    const card = lastQuizCard();
    const bad = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, {
      quizId: card.quizId,
      answers: [{ questionId: "q1", optionId: "不存在" }],
    }) as { ok: boolean };
    expect(bad.ok).toBe(false);
    const good = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, {
      quizId: card.quizId,
      answers: [{ questionId: "q1", optionId: "q1-opt-2" }],
    }) as { ok: boolean };
    expect(good.ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ answers: [{ grading: "incorrect" }] });
  });

  it("run 终态清理：pending 以 AbortError 结算并广播 cancelled", async () => {
    const pending = requestPopQuiz([sampleChoice()], { runId: "run-cancel" });
    const card = lastQuizCard();
    cancelPendingQuizzesForRun("run-cancel");
    await expect(pending).rejects.toSatisfy(isAbortError);
    const settled = send.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_SETTLED).at(-1);
    expect(settled?.[1]).toMatchObject({ quizId: card.quizId, runId: "run-cancel", reason: "cancelled" });
    // 清理后再提交返回 not found
    const late = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, {
      quizId: card.quizId,
      answers: [{ questionId: "q1", optionId: "q1-opt-1" }],
    }) as { ok: boolean; error: string };
    expect(late.ok).toBe(false);
    expect(late.error).toBe("E_QUIZ_NOT_FOUND");
  });

  it("未知 quizId 的提交与跳过都安全返回 not found", () => {
    const resolve = ipcHandler(IPC.POP_QUIZ_RESOLVE)({}, { quizId: "quiz-nope", answers: [] }) as { ok: boolean };
    const skip = ipcHandler(IPC.POP_QUIZ_SKIP)({}, { quizId: "quiz-nope" }) as { ok: boolean };
    expect(resolve.ok).toBe(false);
    expect(skip.ok).toBe(false);
  });
});
