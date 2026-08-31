import { createHash } from "crypto";
import type { AskClarificationInput, AskMissingField, AskUserAnswer } from "../../shared/ask-clarification";
import type { ToolCallResult } from "./types";
import type { JsonSchemaProp, ToolDefinition } from "./tool-registry";
import { parseAndValidateToolCallArguments } from "./tool-argument-validator";

export interface PendingActionContext {
  runId: string;
  planId?: string;
  stepId?: string;
  stepAttemptId?: string;
}

export interface PendingAction {
  toolId: string;
  capability: string;
  objective: string;
  targetRefs: string[];
  afterSuccess: "respond" | "replan";
  argumentsSnapshot: Record<string, unknown>;
  schemaFingerprint: string;
  bindings: Record<string, string>;
  context: PendingActionContext;
  createdAt: number;
}

export type AskResolution =
  | {
      kind: "resume_action";
      action: {
        toolId: string;
        capability: string;
        objective: string;
        targetRefs: string[];
        afterSuccess: "respond" | "replan";
        args: Record<string, unknown>;
      };
    }
  | {
      kind: "return_to_agent";
      answers: AskUserAnswer;
      reason:
        | "semantic_question"
        | "normalization_failed"
        | "incomplete_arguments"
        | "schema_validation_failed"
        | "stale_pending_action";
    };

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintToolSchema(tool: ToolDefinition): string {
  return createHash("sha256").update(stableSerialize(tool.inputSchema)).digest("hex");
}

function isSupportedBinding(schema: JsonSchemaProp): boolean {
  return schema.type === "string"
    || schema.type === "number"
    || schema.type === "integer"
    || schema.type === "boolean";
}

export function createPendingAction(input: {
  tool: ToolDefinition;
  capability: string;
  objective: string;
  targetRefs: string[];
  afterSuccess: "respond" | "replan";
  argumentsSnapshot: Record<string, unknown>;
  missingFields: string[];
  context: PendingActionContext;
  createdAt?: number;
}): PendingAction {
  const required = new Set(input.tool.inputSchema.required ?? []);
  const uniqueFields = [...new Set(input.missingFields)];
  if (uniqueFields.length === 0 || uniqueFields.length > 3 || uniqueFields.length !== input.missingFields.length) {
    throw new Error("E_PENDING_ACTION_BINDING_INVALID");
  }
  const bindings: Record<string, string> = {};
  for (const field of uniqueFields) {
    const schema = input.tool.inputSchema.properties[field];
    if (!schema || !required.has(field) || field in input.argumentsSnapshot) {
      throw new Error("E_PENDING_ACTION_BINDING_INVALID");
    }
    if (!isSupportedBinding(schema)) throw new Error("E_PENDING_ACTION_BINDING_UNSUPPORTED");
    bindings[field] = field;
  }
  return {
    toolId: input.tool.id,
    capability: input.capability,
    objective: input.objective,
    targetRefs: [...input.targetRefs],
    afterSuccess: input.afterSuccess,
    argumentsSnapshot: { ...input.argumentsSnapshot },
    schemaFingerprint: fingerprintToolSchema(input.tool),
    bindings,
    context: { ...input.context },
    createdAt: input.createdAt ?? Date.now(),
  };
}

function schemaOptions(schema: JsonSchemaProp): AskMissingField["allowedOptions"] {
  if (schema.type === "boolean") {
    return [
      { label: "是", value: "true" },
      { label: "否", value: "false" },
    ];
  }
  if ("enum" in schema && schema.enum && schema.enum.length >= 2) {
    return schema.enum.map((value) => ({ label: value, value }));
  }
  return undefined;
}

export function buildPendingAskInput(
  pendingAction: PendingAction,
  tool: ToolDefinition,
  userRequest: string,
): AskClarificationInput {
  return {
    userRequest,
    missingFields: Object.entries(pendingAction.bindings).map(([field, argumentPath]) => {
      const schema = tool.inputSchema.properties[argumentPath];
      const allowedOptions = schemaOptions(schema);
      return {
        field,
        reason: schema.description?.trim() || `执行 ${tool.name} 还缺少 ${field}`,
        required: true,
        questionHint: schema.description?.trim() || `请确认 ${field}`,
        typeHint: allowedOptions ? "single_select" : "text",
        allowedOptions,
        candidateHints: allowedOptions?.map((option) => option.label) ?? [],
        allowCustom: true,
      };
    }),
  };
}

function sameContext(expected: PendingActionContext, actual: PendingActionContext): boolean {
  return expected.runId === actual.runId
    && expected.planId === actual.planId
    && expected.stepId === actual.stepId
    && expected.stepAttemptId === actual.stepAttemptId;
}

function normalizeBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "是", "允许", "启用"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "否", "拒绝", "禁用"].includes(normalized)) return false;
  return undefined;
}

function normalizeValue(raw: string, schema: JsonSchemaProp): unknown | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const alias = Object.entries(schema.askAliases ?? {})
    .find(([label]) => label.toLowerCase() === value.toLowerCase())?.[1];
  const candidate = alias ?? value;
  if (schema.type === "string") {
    if (typeof candidate !== "string") return undefined;
    if (!("enum" in schema) || !schema.enum) return candidate;
    return schema.enum.find((allowed) => allowed === candidate)
      ?? schema.enum.find((allowed) => allowed.toLowerCase() === candidate.toLowerCase());
  }
  if (schema.type === "number") {
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : undefined;
    if (typeof candidate !== "string") return undefined;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(candidate)) return undefined;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (schema.type === "integer") {
    if (typeof candidate === "number") return Number.isSafeInteger(candidate) ? candidate : undefined;
    if (typeof candidate !== "string" || !/^[+-]?\d+$/.test(candidate)) return undefined;
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (schema.type === "boolean") {
    if (typeof candidate === "boolean") return candidate;
    return typeof candidate === "string" ? normalizeBoolean(candidate) : undefined;
  }
  return undefined;
}

function returnToAgent(answers: AskUserAnswer, reason: Extract<AskResolution, { kind: "return_to_agent" }>["reason"]): AskResolution {
  return { kind: "return_to_agent", answers, reason };
}

export function resolvePendingActionAnswers(input: {
  pendingAction: PendingAction;
  currentTool?: ToolDefinition;
  answer: AskUserAnswer;
  currentContext: PendingActionContext;
  toolResults: ToolCallResult[];
}): AskResolution {
  const { pendingAction, currentTool, answer } = input;
  if (!currentTool || currentTool.id !== pendingAction.toolId || !currentTool.enabled
    || !sameContext(pendingAction.context, input.currentContext)) {
    return returnToAgent(answer, "stale_pending_action");
  }
  if (fingerprintToolSchema(currentTool) !== pendingAction.schemaFingerprint) {
    return returnToAgent(answer, "schema_validation_failed");
  }

  const bindings = Object.entries(pendingAction.bindings);
  if (answer.answers.length !== bindings.length) return returnToAgent(answer, "incomplete_arguments");
  const byField = new Map(answer.answers.map((item) => [item.field, item]));
  if (byField.size !== answer.answers.length) return returnToAgent(answer, "incomplete_arguments");

  const args = { ...pendingAction.argumentsSnapshot };
  for (const [field, argumentPath] of bindings) {
    const item = byField.get(field);
    const schema = currentTool.inputSchema.properties[argumentPath];
    if (!item || !schema) return returnToAgent(answer, "incomplete_arguments");
    const selected = item.selectedValues;
    if (selected && selected.length !== 1) return returnToAgent(answer, "normalization_failed");
    if (selected?.length && item.customText) return returnToAgent(answer, "normalization_failed");
    const raw = selected?.[0] ?? item.customText;
    if (typeof raw !== "string") return returnToAgent(answer, "normalization_failed");
    const normalized = normalizeValue(raw, schema);
    if (normalized === undefined) return returnToAgent(answer, "normalization_failed");
    args[argumentPath] = normalized;
  }

  try {
    parseAndValidateToolCallArguments({
      id: `resume_${answer.requestId}`,
      name: currentTool.id,
      arguments: JSON.stringify(args),
    }, currentTool, pendingAction.targetRefs, input.toolResults);
  } catch {
    return returnToAgent(answer, "schema_validation_failed");
  }

  return {
    kind: "resume_action",
    action: {
      toolId: pendingAction.toolId,
      capability: pendingAction.capability,
      objective: pendingAction.objective,
      targetRefs: [...pendingAction.targetRefs],
      afterSuccess: pendingAction.afterSuccess,
      args,
    },
  };
}
