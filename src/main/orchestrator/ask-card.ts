import type {
  AskClarificationCard,
  AskClarificationOutput,
  AskUserAnswer,
} from "../../shared/ask-clarification";

const CUSTOM_OPTION = {
  value: "__custom__",
  label: "其他，我自己填写",
} as const;

export function buildAskCard(output: AskClarificationOutput): AskClarificationCard {
  return {
    intro: output.intro,
    questions: output.questions.slice(0, 3).map((question) => ({
      ...question,
      options: question.type === "text"
        ? []
        : [
            ...question.options
              .filter((option) => option.value !== CUSTOM_OPTION.value)
              .slice(0, 3),
            ...(question.allowCustom ? [CUSTOM_OPTION] : []),
          ].slice(0, 4),
    })),
    deferredFields: output.deferredFields,
  };
}

function invalidAnswer(): never {
  throw new Error("E_ASK_ANSWER_INVALID");
}

export function validateAskUserAnswer(
  card: AskClarificationCard,
  requestId: string,
  answer: AskUserAnswer,
): AskUserAnswer {
  if (!answer || !Array.isArray(answer.answers)) invalidAnswer();
  const questions = new Map(card.questions.map((question) => [question.field, question]));
  const seen = new Set<string>();
  const answers = answer.answers.map((item) => {
    if (!item || typeof item.field !== "string" || seen.has(item.field)) invalidAnswer();
    const question = questions.get(item.field);
    if (!question) invalidAnswer();
    seen.add(item.field);
    const customText = item.customText?.trim();
    const selectedValues = item.selectedValues?.filter((value) => value !== "__custom__");
    if (question.type === "text") {
      if (!customText) invalidAnswer();
      return { field: item.field, customText };
    }
    const allowed = new Set(question.options
      .filter((option) => option.value !== "__custom__")
      .map((option) => option.value));
    if (selectedValues?.some((value) => !allowed.has(value))) invalidAnswer();
    if (question.type === "single_select" && (selectedValues?.length ?? 0) > 1) invalidAnswer();
    if ((!selectedValues || selectedValues.length === 0) && !customText) invalidAnswer();
    if (customText && !question.allowCustom) invalidAnswer();
    return {
      field: item.field,
      ...(selectedValues?.length ? { selectedValues } : {}),
      ...(customText ? { customText } : {}),
    };
  });
  if (answers.length !== card.questions.length) invalidAnswer();
  return { requestId, answers };
}
