import type {
  AskClarificationInput,
  AskClarificationOutput,
  AskFieldType,
  AskMissingField,
  AskOption,
  AskQuestion,
} from "../../shared/ask-clarification";
import type { ChatRequest, ChatResponse } from "./vendors/types";
import type { ChatMessage } from "./vendors/types";
import type { TrustedAskUserProfile } from "../../shared/ask-clarification";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function fieldType(value: unknown): AskFieldType {
  if (value === "single_select" || value === "multi_select" || value === "text") return value;
  throw new Error("question.type is invalid");
}

function authoritativeOptions(field: AskMissingField): AskOption[] {
  if (field.allowedOptions?.length) return field.allowedOptions;
  return (field.candidateHints ?? []).map((hint) => ({ value: hint, label: hint }));
}

function normalizeOptions(
  value: unknown,
  field: AskMissingField,
  type: AskFieldType,
): AskOption[] {
  if (type === "text") return [];
  if (!Array.isArray(value)) throw new Error("question.options is invalid");
  const allowed = new Map(
    authoritativeOptions(field).map((option) => [option.value, option]),
  );
  const result: AskOption[] = [];
  for (const item of value) {
    const option = record(item, "question.option");
    const optionValue = text(option.value, "question.option.value", 200);
    if (optionValue === "__custom__") continue;
    const trusted = allowed.get(optionValue);
    if (!trusted) throw new Error("question.option is not allowed");
    if (!result.some((existing) => existing.value === optionValue)) {
      result.push(trusted);
    }
    if (result.length === 3) break;
  }
  return result;
}

export function normalizeAskClarificationOutput(
  value: unknown,
  input: AskClarificationInput,
): AskClarificationOutput {
  const root = record(value, "AskClarificationOutput");
  if (!Array.isArray(root.questions) || !Array.isArray(root.deferredFields)) {
    throw new Error("AskClarificationOutput arrays are invalid");
  }
  const fields = new Map(input.missingFields.map((field) => [field.field, field]));
  const used = new Set<string>();
  const questions: AskQuestion[] = [];
  for (const item of root.questions) {
    if (questions.length === 3) break;
    const question = record(item, "question");
    const fieldName = text(question.field, "question.field", 120);
    const field = fields.get(fieldName);
    if (!field || used.has(fieldName)) throw new Error("question.field is not authoritative");
    const type = fieldType(question.type);
    const expectedType = field.typeHint
      ?? (authoritativeOptions(field).length > 0 ? "single_select" : "text");
    if (type !== expectedType) throw new Error("question.type changed field meaning");
    used.add(fieldName);
    questions.push({
      field: fieldName,
      question: text(question.question, "question.question"),
      type,
      options: normalizeOptions(question.options, field, type),
      allowCustom: typeof question.allowCustom === "boolean"
        ? question.allowCustom
        : (field.allowCustom ?? type !== "text"),
      freeTextPlaceholder: typeof question.freeTextPlaceholder === "string"
        ? question.freeTextPlaceholder.trim().slice(0, 300)
        : "",
    });
  }
  if (questions.length === 0) throw new Error("questions is empty");
  const deferredFields = root.deferredFields
    .map((item) => text(item, "deferredFields", 120))
    .filter((fieldName) => fields.has(fieldName) && !used.has(fieldName));
  return {
    intro: text(root.intro, "intro", 300),
    questions,
    deferredFields: [...new Set(deferredFields)],
  };
}

function fallbackQuestion(field: AskMissingField): AskQuestion {
  const options = authoritativeOptions(field).slice(0, 3);
  const type = field.typeHint ?? (options.length > 0 ? "single_select" : "text");
  return {
    field: field.field,
    question: field.questionHint?.trim() || field.reason,
    type,
    options: type === "text" ? [] : options,
    allowCustom: field.allowCustom ?? type !== "text",
    freeTextPlaceholder: type === "text" ? "请填写你的具体要求" : "填写其他选择",
  };
}

export function buildFallbackAskClarification(
  input: AskClarificationInput,
): AskClarificationOutput {
  const address = input.recentAddressedUser
    ? ""
    : input.trustedUserProfile?.callPreference?.trim()
      || input.trustedUserProfile?.nickname?.trim()
      || "伙伴";
  const questions = input.missingFields.slice(0, 3).map(fallbackQuestion);
  return {
    intro: `${address ? `${address}，` : ""}想让结果更合你心意，我还需要确认一点呀。`,
    questions,
    deferredFields: input.missingFields.slice(3).map((field) => field.field),
  };
}

export interface ResolveAskClarificationInput {
  model: string;
  askSystemContent: string;
  input: AskClarificationInput;
}

export function detectRecentAddressedUser(
  messages: ChatMessage[],
  profile?: TrustedAskUserProfile,
): boolean {
  const addresses = [profile?.callPreference, profile?.nickname]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (addresses.length === 0) return false;
  return messages
    .filter((message) => message.role === "assistant")
    .slice(-2)
    .some((message) => {
      const content = message.content;
      return typeof content === "string"
        && addresses.some((address) => content.includes(address));
    });
}

function parseJsonText(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  return JSON.parse(withoutFence);
}

export async function resolveAskClarification(
  requestInput: ResolveAskClarificationInput,
  invoke: (request: ChatRequest) => Promise<ChatResponse>,
): Promise<AskClarificationOutput> {
  if (!requestInput.askSystemContent.trim()) {
    return buildFallbackAskClarification(requestInput.input);
  }
  try {
    const response = await invoke({
      model: requestInput.model,
      messages: [
        { role: "system", content: requestInput.askSystemContent },
        {
          role: "user",
          content: JSON.stringify({
            protocol: "ask_clarification.v1",
            ...requestInput.input,
          }),
        },
      ],
      stream: false,
      maxTokens: 1_600,
      structuredOutput: {
        mode: "prompt_json",
        sendJsonObjectHint: true,
      },
    });
    return normalizeAskClarificationOutput(
      parseJsonText(response.text),
      requestInput.input,
    );
  } catch {
    return buildFallbackAskClarification(requestInput.input);
  }
}
