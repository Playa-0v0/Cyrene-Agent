import { describe, expect, it } from "vitest";
import {
  buildFallbackAskClarification,
  detectRecentAddressedUser,
  normalizeAskClarificationOutput,
  resolveAskClarification,
} from "./ask-soul";
import type { AskClarificationInput } from "../../shared/ask-clarification";
import type { ChatRequest, ChatResponse } from "./vendors/types";

const input: AskClarificationInput = {
  userRequest: "生成一份文档",
  trustedUserProfile: {
    callPreference: "伙伴",
    gender: "male",
  },
  missingFields: [
    {
      field: "topic",
      reason: "文档主题未知",
      required: true,
      questionHint: "这份文档主要写什么？",
      typeHint: "text",
      allowCustom: false,
    },
    {
      field: "format",
      reason: "输出格式未知",
      required: true,
      questionHint: "希望生成哪种格式？",
      typeHint: "single_select",
      allowedOptions: [
        { value: "word", label: "Word 文档" },
        { value: "markdown", label: "Markdown 文档" },
        { value: "pdf", label: "PDF 文档" },
        { value: "excel", label: "Excel 表格" },
      ],
      allowCustom: true,
    },
  ],
};

describe("Ask Soul clarification contract", () => {
  it("keeps authoritative fields, caps model choices at three, and leaves custom insertion to Runtime", () => {
    const result = normalizeAskClarificationOutput({
      intro: "伙伴，想把这份文档做得更合你心意，我还需要确认两件小事呀。",
      questions: [
        {
          field: "topic",
          question: "这份文档主要写什么？",
          type: "text",
          options: [],
          allowCustom: false,
          freeTextPlaceholder: "例如：项目说明",
        },
        {
          field: "format",
          question: "希望生成哪种格式？",
          type: "single_select",
          options: [
            { value: "word", label: "Word 文档" },
            { value: "markdown", label: "Markdown 文档" },
            { value: "pdf", label: "PDF 文档" },
            { value: "__custom__", label: "其他，我自己填写" },
          ],
          allowCustom: true,
          freeTextPlaceholder: "填写其他格式",
        },
      ],
      deferredFields: [],
    }, input);

    expect(result.questions).toHaveLength(2);
    expect(result.questions[1].options).toEqual([
      { value: "word", label: "Word 文档" },
      { value: "markdown", label: "Markdown 文档" },
      { value: "pdf", label: "PDF 文档" },
    ]);
  });

  it("builds a usable local fallback without inventing choices", () => {
    const result = buildFallbackAskClarification(input);

    expect(result.intro).toContain("伙伴");
    expect(result.questions).toEqual([
      expect.objectContaining({ field: "topic", type: "text", options: [] }),
      expect.objectContaining({
        field: "format",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "markdown", label: "Markdown 文档" },
          { value: "pdf", label: "PDF 文档" },
        ],
      }),
    ]);
  });

  it("uses the dedicated Ask prompt and returns validated structured card copy", async () => {
    const invoke = async (request: ChatRequest): Promise<ChatResponse> => {
      expect(request.messages[0]?.content).toBe("ASK_SYSTEM\n\nASK_PERSONA\n\nASK_QUOTES");
      expect(request.messages[1]?.content).toContain('"trustedUserProfile"');
      return {
        assistantMessage: { role: "assistant", content: "{}" },
        text: JSON.stringify({
          intro: "伙伴，想把这份文档做得更合你心意，我还需要确认两件小事呀。",
          questions: [
            {
              field: "topic",
              question: "这份文档主要写什么？",
              type: "text",
              options: [],
              allowCustom: false,
              freeTextPlaceholder: "例如：项目说明",
            },
            {
              field: "format",
              question: "希望生成哪种格式？",
              type: "single_select",
              options: [
                { value: "word", label: "Word 文档" },
                { value: "markdown", label: "Markdown 文档" },
              ],
              allowCustom: true,
              freeTextPlaceholder: "填写其他格式",
            },
          ],
          deferredFields: [],
        }),
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const result = await resolveAskClarification({
      model: "m",
      askSystemContent: "ASK_SYSTEM\n\nASK_PERSONA\n\nASK_QUOTES",
      input,
    }, invoke);

    expect(result.questions.map((question) => question.field)).toEqual(["topic", "format"]);
  });

  it("detects a recently used preferred address so Ask Soul does not repeat it", () => {
    expect(detectRecentAddressedUser([
      { role: "user", content: "生成一份文档" },
      { role: "assistant", content: "伙伴，我在听呢。" },
    ], { callPreference: "伙伴", nickname: "小王", gender: "male" })).toBe(true);
  });
});
