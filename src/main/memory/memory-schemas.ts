/**
 * Memory Structured Output Schemas — 三个 Memory 操作的 parseSchema / validateBusiness。
 *
 * 配合 runStructuredOutput<T>() 使用：
 *   parseSchema: 从 LLM 输出中提取并校验结构化对象
 *   validateBusiness: 业务级别校验（当前均为 pass-through）
 */

import type { BusinessValidationResult } from "../orchestrator/structured-output/runner";
import type { StructuredErrorDisposition } from "../orchestrator/structured-output/errors";
import type { MemoryCandidate, MemoryConflictResolution } from "./memory-types";
import type { ExtractedEntity } from "./entity-graph";

// ── 公共工具 ──

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, i) => {
    if (typeof item !== "string") throw new Error(`${label}[${i}] must be a string`);
    return item;
  });
}

// ── 公共常量 ──

const VALID_LAYERS = new Set(["L0", "L1", "L2"]);
const VALID_IMPORTANCE = new Set(["low", "medium", "high"]);
const VALID_STABILITY = new Set(["one_off", "situational", "stable"]);
const VALID_CERTAINTY = new Set(["explicit", "inferred", "uncertain"]);
const VALID_ATTRIBUTION = new Set(["user_explicit", "assistant_inferred", "mixed"]);
const VALID_RESOLUTION_TYPES = new Set([
  "unrelated", "context_difference", "preference_evolution", "direct_conflict", "uncertain",
]);
const VALID_MEMORY_STATUS = new Set(["active", "aging", "archived", "superseded", "merged"]);
const VALID_ENTITY_TYPES = new Set(["person", "place", "concept", "preference", "organization"]);

// ── L2 slug 校验 ──

const SLUG_MAX_LENGTH = 20;
/**
 * slug 允许字符：中文字符（含扩展 A 区）、英文字母、数字、下划线、连字符。
 * 拒绝空格、所有标点、引号、emoji。
 */
const SLUG_ALLOWED_PATTERN = /^[\u3400-\u9fa5A-Za-z0-9_-]+$/;

/**
 * 校验 L2 候选 slug 是否合法（≤20 字，仅中文/字母/数字/_/-，无标点/引号/emoji）。
 * 非法 slug 直接丢弃（候选照常入库，回退到内部 id 作为文件名），不抛错。
 */
export function isValidSlug(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SLUG_MAX_LENGTH) return false;
  if (/\p{Extended_Pictographic}/u.test(trimmed)) return false;
  return SLUG_ALLOWED_PATTERN.test(trimmed);
}

// ── L2 sourceQuote 校验 ──

const SOURCE_QUOTE_MAX_LENGTH = 500;

/**
 * 校验 L2 候选 sourceQuote 是否合法（非空字符串，trim 后 ≤500 字）。
 * 允许任意 Unicode（标点/空格/emoji 都行，因为是原文对话）。
 * 超长或空直接丢弃（候选照常入库），不抛错。
 * 规则比 slug 宽松：sourceQuote 是展示用原文，slug 是文件名。
 */
export function isValidSourceQuote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= SOURCE_QUOTE_MAX_LENGTH;
}

// ── 用于 provider_json_schema 的 JSON Schema ──
// A 档模型（GPT/Claude/Kimi/Doubao）会收到这些 schema，严格约束输出结构。

export const MEMORY_JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["L0", "L1", "L2"] },
          field: { type: "string" },
          summary: { type: "string" },
          slug: { type: "string" },
          sourceQuote: { type: "string" },
          content: { type: "string" },
          confidence: { type: "number" },
          triggerText: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
          stability: { type: "string", enum: ["one_off", "situational", "stable"] },
          certainty: { type: "string", enum: ["explicit", "inferred", "uncertain"] },
          attribution: { type: "string", enum: ["user_explicit", "assistant_inferred", "mixed"] },
          evidenceQuotes: { type: "array", items: { type: "string" } },
          contextSummary: { type: "string" },
          shouldWrite: { type: "boolean" },
          reason: { type: "string" },
          forbiddenOverclaims: { type: "array", items: { type: "string" } },
        },
        required: ["layer", "content", "confidence", "triggerText"],
        additionalProperties: false,
      },
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["person", "place", "concept", "preference", "organization"] },
          aliases: { type: "array", items: { type: "string" } },
        },
        required: ["name", "type"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates", "entities"],
  additionalProperties: false,
};

export const MEMORY_REFLECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["L0", "L1"] },
          field: { type: "string" },
          content: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["layer", "content", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["updates"],
  additionalProperties: false,
};

export const MEMORY_RESOLVE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    resolutionType: { type: "string", enum: [...VALID_RESOLUTION_TYPES] },
    resolvedSummary: { type: "string" },
    currentSummary: { type: "string" },
    historicalSummary: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number" },
    actions: {
      type: "object",
      properties: {
        createResolvedMemory: { type: "boolean" },
        oldMemoryStatus: { type: "string", enum: [...VALID_MEMORY_STATUS] },
        newMemoryStatus: { type: "string", enum: [...VALID_MEMORY_STATUS] },
        shouldUpdateCoreMemory: { type: "boolean" },
        shouldAskUser: { type: "boolean" },
        clarificationNeeded: { type: "boolean" },
      },
      required: ["createResolvedMemory"],
      additionalProperties: false,
    },
  },
  required: ["resolutionType", "reason", "confidence", "actions"],
  additionalProperties: false,
};

// ── Judge Schema ──

/**
 * Memory Judge 的完整输出：记忆候选 + 顺手抽取的命名实体。
 *
 * 实体抽取复用 judge 的 LLM 调用（零额外调用），避免旧正则贪婪匹配产生的垃圾实体。
 * 实体由 EntityGraph.ingestEntities() 入库。
 */
export interface MemoryJudgeResult {
  candidates: MemoryCandidate[];
  entities: ExtractedEntity[];
}

function parseMemoryCandidate(value: unknown): MemoryCandidate {
  const obj = requiredObject(value, "candidate");
  const layer = requiredString(obj.layer, "layer");
  if (!VALID_LAYERS.has(layer)) throw new Error(`layer must be L0/L1/L2, got "${layer}"`);
  const result: MemoryCandidate = {
    layer: layer as MemoryCandidate["layer"],
    content: requiredString(obj.content, "content"),
    confidence: requiredNumber(obj.confidence, "confidence"),
    triggerText: requiredString(obj.triggerText, "triggerText"),
  };
  if (typeof obj.field === "string" && obj.field.trim()) result.field = obj.field.trim();
  if (typeof obj.summary === "string" && obj.summary.trim()) result.summary = obj.summary.trim();
  // slug 仅对 L2 候选有意义；L0/L1 的 slug 一律丢弃
  if (layer === "L2" && isValidSlug(obj.slug)) {
    result.slug = (obj.slug as string).trim();
  }
  // sourceQuote 仅对 L2 候选有意义；L0/L1 的 sourceQuote 一律丢弃
  if (layer === "L2" && isValidSourceQuote(obj.sourceQuote)) {
    result.sourceQuote = (obj.sourceQuote as string).trim();
  }
  if (VALID_IMPORTANCE.has(obj.importance as string)) result.importance = obj.importance as MemoryCandidate["importance"];
  if (VALID_STABILITY.has(obj.stability as string)) result.stability = obj.stability as MemoryCandidate["stability"];
  if (VALID_CERTAINTY.has(obj.certainty as string)) result.certainty = obj.certainty as MemoryCandidate["certainty"];
  if (VALID_ATTRIBUTION.has(obj.attribution as string)) result.attribution = obj.attribution as MemoryCandidate["attribution"];
  if (Array.isArray(obj.evidenceQuotes)) result.evidenceQuotes = stringArray(obj.evidenceQuotes, "evidenceQuotes");
  if (typeof obj.contextSummary === "string") result.contextSummary = obj.contextSummary;
  if (typeof obj.shouldWrite === "boolean") result.shouldWrite = obj.shouldWrite;
  if (typeof obj.reason === "string") result.reason = obj.reason;
  if (Array.isArray(obj.forbiddenOverclaims)) result.forbiddenOverclaims = stringArray(obj.forbiddenOverclaims, "forbiddenOverclaims");
  return result;
}

function parseExtractedEntity(value: unknown): ExtractedEntity {
  const obj = requiredObject(value, "entity");
  const name = requiredString(obj.name, "name");
  const type = requiredString(obj.type, "type");
  if (!VALID_ENTITY_TYPES.has(type)) {
    throw new Error(`entity type must be one of ${[...VALID_ENTITY_TYPES].join(", ")}, got "${type}"`);
  }
  const result: ExtractedEntity = { name, type: type as ExtractedEntity["type"] };
  if (Array.isArray(obj.aliases)) {
    result.aliases = stringArray(obj.aliases, "aliases")
      .map((a) => a.trim())
      .filter((a) => a && a !== name);
  }
  return result;
}

/**
 * 从 LLM 输出中提取 MemoryJudgeResult（候选 + 实体）。
 * runStructuredOutput 的 parseSchema 回调。
 *
 * 兼容两种顶层形式：
 *   - { candidates: [...], entities: [...] }（新形式，A/D 档严格 schema）
 *   - 纯数组（旧形式，无实体）—— 实体为空数组，保持向后兼容
 */
export function parseMemoryJudgeResult(value: unknown): MemoryJudgeResult {
  if (Array.isArray(value)) {
    // 旧形式：纯 candidates 数组，无实体
    return {
      candidates: value.map((item, i) => {
        try { return parseMemoryCandidate(item); }
        catch (err) { throw new Error(`candidate[${i}]: ${err instanceof Error ? err.message : String(err)}`); }
      }),
      entities: [],
    };
  }
  const obj = requiredObject(value, "judge result");
  const candidatesRaw = obj.candidates;
  if (!Array.isArray(candidatesRaw)) {
    throw new Error("Memory judge result.candidates must be an array");
  }
  const candidates = candidatesRaw.map((item, i) => {
    try { return parseMemoryCandidate(item); }
    catch (err) { throw new Error(`candidate[${i}]: ${err instanceof Error ? err.message : String(err)}`); }
  });
  const entitiesRaw = Array.isArray(obj.entities) ? obj.entities : [];
  const entities = entitiesRaw.map((item, i) => {
    try { return parseExtractedEntity(item); }
    catch (err) { throw new Error(`entity[${i}]: ${err instanceof Error ? err.message : String(err)}`); }
  });
  return { candidates, entities };
}

export function validateMemoryJudgeBusiness(
  result: MemoryJudgeResult,
): BusinessValidationResult<MemoryJudgeResult> {
  // 空候选是合法结果：表示最近对话没有值得写入的记忆。
  // 空实体也是合法的：表示这段对话没有值得记录的命名实体。
  return { status: "accepted", value: result };
}

// ── Compress Schema ──

export interface MemoryCompressionGroup {
  ids: string[];
  summary: string;
}

function parseCompressionGroup(value: unknown): MemoryCompressionGroup {
  const obj = requiredObject(value, "group");
  return {
    ids: stringArray(obj.ids, "ids"),
    summary: requiredString(obj.summary, "summary"),
  };
}

/**
 * 从 LLM 输出中提取 MemoryCompressionGroup 数组。
 */
export function parseMemoryCompressResult(value: unknown): MemoryCompressionGroup[] {
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).groups)) {
    arr = (value as Record<string, unknown>).groups as unknown[];
  } else {
    throw new Error("Memory compress result must be an array or { groups: [...] }");
  }
  return arr.map((item, i) => {
    try {
      return parseCompressionGroup(item);
    } catch (err) {
      throw new Error(`group[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function validateMemoryCompressBusiness(
  groups: MemoryCompressionGroup[],
): BusinessValidationResult<MemoryCompressionGroup[]> {
  if (groups.length === 0) {
    return { status: "rejected", error: { layer: "schema", code: "EMPTY_GROUPS", disposition: "fail_closed" } };
  }
  return { status: "accepted", value: groups };
}

// ── Resolve Schema ──

function parseResolutionActions(value: unknown): MemoryConflictResolution["actions"] {
  const obj = requiredObject(value, "actions");
  const result: MemoryConflictResolution["actions"] = {
    createResolvedMemory: obj.createResolvedMemory === true,
  };
  if (VALID_MEMORY_STATUS.has(obj.oldMemoryStatus as string)) {
    result.oldMemoryStatus = obj.oldMemoryStatus as MemoryConflictResolution["actions"]["oldMemoryStatus"];
  }
  if (VALID_MEMORY_STATUS.has(obj.newMemoryStatus as string)) {
    result.newMemoryStatus = obj.newMemoryStatus as MemoryConflictResolution["actions"]["newMemoryStatus"];
  }
  if (obj.shouldUpdateCoreMemory === true) result.shouldUpdateCoreMemory = true;
  if (obj.shouldAskUser === true) result.shouldAskUser = true;
  if (obj.clarificationNeeded === true) result.clarificationNeeded = true;
  return result;
}

/**
 * 从 LLM 输出中提取 MemoryConflictResolution。
 */
export function parseMemoryResolveResult(value: unknown): MemoryConflictResolution {
  const obj = requiredObject(value, "resolution");
  const resolutionType = requiredString(obj.resolutionType, "resolutionType");
  if (!VALID_RESOLUTION_TYPES.has(resolutionType)) {
    throw new Error(`resolutionType must be one of ${[...VALID_RESOLUTION_TYPES].join(", ")}, got "${resolutionType}"`);
  }
  const reason = requiredString(obj.reason, "reason");
  const confidence = requiredNumber(obj.confidence, "confidence");
  const result: MemoryConflictResolution = {
    resolutionType: resolutionType as MemoryConflictResolution["resolutionType"],
    reason,
    confidence,
    actions: parseResolutionActions(obj.actions),
  };
  if (typeof obj.resolvedSummary === "string" && obj.resolvedSummary.trim()) {
    result.resolvedSummary = obj.resolvedSummary.trim();
  }
  if (typeof obj.currentSummary === "string" && obj.currentSummary.trim()) {
    result.currentSummary = obj.currentSummary.trim();
  }
  if (typeof obj.historicalSummary === "string" && obj.historicalSummary.trim()) {
    result.historicalSummary = obj.historicalSummary.trim();
  }
  return result;
}

export function validateMemoryResolveBusiness(
  resolution: MemoryConflictResolution,
): BusinessValidationResult<MemoryConflictResolution> {
  if (!resolution.reason.trim()) {
    return { status: "rejected", error: { layer: "schema", code: "EMPTY_REASON", disposition: "fail_closed" } };
  }
  return { status: "accepted", value: resolution };
}

// ── Reflection Schema ──

export interface MemoryReflectionItem {
  layer: "L0" | "L1";
  field?: string;
  content: string;
  confidence: number;
}

function parseReflectionItem(value: unknown): MemoryReflectionItem {
  const obj = requiredObject(value, "reflection item");
  const layer = requiredString(obj.layer, "layer");
  if (layer !== "L0" && layer !== "L1") throw new Error(`layer must be L0/L1, got "${layer}"`);
  return {
    layer,
    field: optionalString(obj.field),
    content: requiredString(obj.content, "content"),
    confidence: requiredNumber(obj.confidence, "confidence"),
  };
}

/**
 * 从 LLM 输出中提取 MemoryReflectionItem 数组。
 */
export function parseMemoryReflectionResult(value: unknown): MemoryReflectionItem[] {
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).updates)) {
    arr = (value as Record<string, unknown>).updates as unknown[];
  } else {
    throw new Error("Memory reflection result must be an array or { updates: [...] }");
  }
  return arr.map((item, i) => {
    try {
      return parseReflectionItem(item);
    } catch (err) {
      throw new Error(`item[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function validateMemoryReflectionBusiness(
  items: MemoryReflectionItem[],
): BusinessValidationResult<MemoryReflectionItem[]> {
  // 空数组是合法的 —— 表示没有需要更新的内容
  return { status: "accepted", value: items };
}
