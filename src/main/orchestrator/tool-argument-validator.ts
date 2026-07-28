import type { JsonSchemaProp, ToolDefinition, ControlledInputPolicy } from "./tool-registry";
import { controlledInputType, controlledInputKind } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { ToolCall } from "./vendors/types";

export function resolveToolForCapability(tools: ToolDefinition[], capability: string): ToolDefinition {
  const matches = tools.filter((tool) => tool.enabled && (tool.capability ?? tool.id) === capability);
  if (matches.length === 0) throw new Error("E_ACTION_CAPABILITY_UNAVAILABLE");
  if (matches.length > 1) throw new Error("E_ACTION_CAPABILITY_AMBIGUOUS");
  return matches[0];
}

function parseArguments(toolCall: ToolCall): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(toolCall.arguments || "{}"); } catch { throw new Error("E_TOOL_ARGUMENT_PROTOCOL"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("E_TOOL_ARGUMENT_PROTOCOL");
  return value as Record<string, unknown>;
}

function validateValue(value: unknown, schema: JsonSchemaProp): boolean {
  if (schema.type === "array" && "items" in schema) {
    return Array.isArray(value) && value.every((item) => validateValue(item, schema.items));
  }
  if (schema.type === "object" && "properties" in schema) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !(key in schema.properties))) return false;
    if (schema.required?.some((key: string) => !(key in record))) return false;
    return Object.entries(record).every(([key, item]) => validateValue(item, schema.properties[key]));
  }
  if (schema.type === "number" && typeof value !== "number") return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  return !("enum" in schema) || schema.enum === undefined
    || (typeof value === "string" && schema.enum.includes(value));
}

function validateRoot(args: Record<string, unknown>, tool: ToolDefinition): void {
  const schema = tool.inputSchema;
  const extraKeys = Object.keys(args).filter((key) => !(key in schema.properties));
  if (extraKeys.length > 0) {
    throw new Error(`E_TOOL_ARGUMENT_SCHEMA: unknown fields: ${extraKeys.join(", ")}`);
  }
  const missingKeys = schema.required?.filter((key) => !(key in args)) ?? [];
  if (missingKeys.length > 0) {
    throw new Error(`E_TOOL_ARGUMENT_SCHEMA: missing required fields: ${missingKeys.join(", ")}`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!validateValue(value, schema.properties[key])) {
      const expected = schema.properties[key].type;
      const actual = Array.isArray(value) ? "array" : typeof value;
      throw new Error(`E_TOOL_ARGUMENT_SCHEMA: field '${key}' expected ${expected}, got ${actual}`);
    }
  }
}

function parsedSuccessfulOutputs(results: ToolCallResult[]): unknown[] {
  return results.filter((result) => result.status === "succeeded").flatMap((result) => {
    try { return [JSON.parse(result.output) as unknown]; } catch { return []; }
  });
}

function collectNamedValues(value: unknown, keyName: string, output: Set<unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedValues(item, keyName, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === keyName) {
      if (Array.isArray(child)) child.forEach((item) => output.add(item));
      else output.add(child);
    }
    collectNamedValues(child, keyName, output);
  }
}

function validateControlledInputs(
  args: Record<string, unknown>,
  tool: ToolDefinition,
  targetRefs: string[],
  toolResults: ToolCallResult[],
): void {
  const successful = parsedSuccessfulOutputs(toolResults);
  for (const [key, policy] of Object.entries(tool.controlledInput ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    const policyType = controlledInputType(policy);
    if (policyType === "context_ref" || policyType === "context_ref_array") {
      const allowed = new Set<unknown>(targetRefs);
      for (const output of successful) {
        for (const refKey of [key, "contextRef", "candidateRef", "setRef"]) collectNamedValues(output, refKey, allowed);
      }
      const values = policyType === "context_ref_array" && Array.isArray(value) ? value : [value];
      if (values.some((item) => !allowed.has(item))) throw new Error("E_TOOL_ARGUMENT_SOURCE");
      continue;
    }
    const allowed = new Set<unknown>();
    successful.forEach((output) => collectNamedValues(output, key, allowed));
    if (!allowed.has(value)) throw new Error("E_TOOL_ARGUMENT_SOURCE");
  }
}

export function parseAndValidateToolCallArguments(
  toolCall: ToolCall,
  tool: ToolDefinition,
  targetRefs: string[],
  toolResults: ToolCallResult[],
): Record<string, unknown> {
  if (toolCall.name !== tool.id) throw new Error("E_NATIVE_TOOL_PROTOCOL");
  const args = parseArguments(toolCall);
  validateRoot(args, tool);
  validateControlledInputs(args, tool, targetRefs, toolResults);
  return args;
}
