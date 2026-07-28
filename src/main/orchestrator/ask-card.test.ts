import { describe, expect, it } from "vitest";
import { buildAskCard, validateAskUserAnswer } from "./ask-card";

describe("buildAskCard", () => {
  it("adds one Runtime-owned custom option last and never exceeds four options", () => {
    const card = buildAskCard({
      intro: "伙伴，还需要你选一下呀。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "markdown", label: "Markdown 文档" },
          { value: "pdf", label: "PDF 文档" },
          { value: "excel", label: "Excel 表格" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    expect(card.questions[0].options).toEqual([
      { value: "word", label: "Word 文档" },
      { value: "markdown", label: "Markdown 文档" },
      { value: "pdf", label: "PDF 文档" },
      { value: "__custom__", label: "其他，我自己填写" },
    ]);
  });

  it("rejects answer values that were not presented by Runtime", () => {
    const card = buildAskCard({
      intro: "伙伴，还需要你选一下呀。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [{ value: "word", label: "Word 文档" }],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    expect(() => validateAskUserAnswer(card, "choice-1", {
      requestId: "forged",
      answers: [{ field: "format", selectedValues: ["shell"] }],
    })).toThrow("E_ASK_ANSWER_INVALID");
  });
});
