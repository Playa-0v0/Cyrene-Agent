/**
 * Task Router -- 判断当前任务的执行策略和需要加载的 Skill。
 *
 * 输出 TaskRoute，决定后续走 direct（现有 Action Gate 流程）还是 plan（P1-4 计划执行）。
 * Router 与 Action Gate 使用独立的结构化输出 LLM 调用，职责不耦合。
 *
 * Feature flag: ENABLE_TASK_ROUTER（默认 false）
 * 关闭时完全跳过 Router，走现有流程，零额外开销。
 */

import { runStructuredOutput } from "./structured-output/runner";
import { resolveStructuredOutputProfile, classifyStructuredOutputEndpoint } from "./structured-output/profiles";
import type { StructuredOutputProfile } from "./structured-output/types";
import type { ChatMessage, ChatRequest, ChatResponse } from "./vendors/types";
import type { ToolDefinition } from "./tool-registry";

// ── 数据结构 ──────────────────────────────

export interface TaskRoute {
  executionMode: "direct" | "plan";
  /** Plan 创建失败降级后保留原始意图 */
  requestedExecutionMode?: "plan";
  /** 降级原因 */
  fallbackReason?: string;
  skillIds: string[];
  reason: string;
}

export interface SkillRouteInfo {
  id: string;
  description: string;
  defaultExecutionMode?: "direct" | "plan";
}

export interface RunTaskRouterInput {
  model: string;
  originalQuery: string;
  contextualizedQuery: string;
  messages: ChatMessage[];
  availableSkills: SkillRouteInfo[];
  availableCapabilities: Array<{
    capabilityId: string;
    description: string;
    hasCompletionEvidence: boolean;
  }>;
  /** 快捷路径预选的 skillIds（精确匹配命中时传入） */
  preselectedSkillIds?: string[];
  profile: StructuredOutputProfile;
  generate: (request: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>;
  signal?: AbortSignal;
}

// ── Feature flag ─────────────────────────

export const ENABLE_TASK_ROUTER = true;

// ── 快捷路径：精确 Skill 匹配 ─────────────

/**
 * 检查用户消息是否精确匹配已注册 Skill 的名称、别名或 ID。
 * 只做精确匹配，不做模糊关键词路由。
 */
export function matchSkillByName(
  userMessage: string,
  skills: SkillRouteInfo[],
): string | undefined {
  const normalized = userMessage.trim().toLowerCase();
  for (const skill of skills) {
    const id = skill.id.toLowerCase();
    // 精确匹配 "使用 xlsx skill" / "调用 xlsx 技能" / "xlsx skill" 等模式
    if (normalized.includes(`使用 ${id} skill`) ||
        normalized.includes(`使用 ${id} 技能`) ||
        normalized.includes(`调用 ${id} skill`) ||
        normalized.includes(`调用 ${id} 技能`) ||
        normalized.includes(`${id} skill`)) {
      return skill.id;
    }
  }
  return undefined;
}

// ── Router LLM 调用 ──────────────────────

const ROUTER_SYSTEM_PROMPT = `你是 Task Router，负责判断当前任务的执行策略。

## 执行模式
- direct：任务简单或工具链固定，不需要显式计划。Action Gate 会逐步决策。
- plan：任务需要多个相互依赖的步骤，需要创建正式计划来跟踪进度。

## 判断依据
- 是否命中已注册 Skill
- 预计需要几个动作
- 动作是否存在依赖
- 是否需要产物校验
- 是否涉及多个领域
- 是否存在不可逆写操作
- 是否需要用户中途确认

## 关键规则
1. 1-2 个独立动作、无依赖 → direct
2. 3+ 个动作或存在依赖链 → plan
3. 只是搜索/查询类（不写文件）→ direct
4. 不确定时 → direct（宁可漏判，不要误判）

"句子长"不等于复杂，"句子短"不等于简单。

## 输出
返回一个 JSON 对象，包含且仅包含以下字段：
- executionMode: "direct" 或 "plan"
- skillIds: 需要加载的 Skill ID 数组（必须来自可用列表，可为空）
- reason: 简短理由

## 示例
"查杭州天气" -> {"executionMode":"direct","skillIds":[],"reason":"单次查询"}
"搜索歌曲然后播放" -> {"executionMode":"direct","skillIds":["cyrene-music-companion"],"reason":"固定续链"}
"生成Excel月度报表" -> {"executionMode":"plan","skillIds":["xlsx"],"reason":"多步+需要校验"}
"搜索AI新闻，筛选重复，比较来源，整理成文档" -> {"executionMode":"plan","skillIds":[],"reason":"多步依赖+多领域"}`;

function routerSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      executionMode: { type: "string", enum: ["direct", "plan"] },
      skillIds: {
        type: "array",
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 100 },
      },
      reason: { type: "string", minLength: 1, maxLength: 300 },
    },
    required: ["executionMode", "skillIds", "reason"],
  };
}

function parseTaskRoute(value: unknown): TaskRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TaskRoute must be an object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.executionMode !== "direct" && obj.executionMode !== "plan") {
    throw new Error("executionMode is invalid");
  }
  if (!Array.isArray(obj.skillIds)) throw new Error("skillIds is invalid");
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    throw new Error("reason is invalid");
  }
  return {
    executionMode: obj.executionMode,
    skillIds: obj.skillIds.map((s) => String(s)),
    reason: obj.reason.trim(),
  };
}

function buildRouterRequest(input: RunTaskRouterInput): ChatRequest {
  const schema = routerSchema();
  const skillCatalog = input.availableSkills.length > 0
    ? input.availableSkills.map((s) => `- ${s.id}: ${s.description}`).join("\n")
    : "（无可用 Skill）";
  const capabilityList = input.availableCapabilities
    .filter((c) => c.hasCompletionEvidence)
    .map((c) => `- ${c.capabilityId}: ${c.description}`)
    .join("\n");
  const preselected = input.preselectedSkillIds?.length
    ? `\n已预选 Skill: ${input.preselectedSkillIds.join(", ")}\n请只判断 executionMode，skillIds 使用预选值。`
    : "";

  const userContent = JSON.stringify({
    userRequest: input.originalQuery.slice(0, 500),
    contextualizedQuery: input.contextualizedQuery.slice(0, 500),
    availableSkills: skillCatalog,
    availableCapabilitiesWithCompletionEvidence: capabilityList || "（无）",
    preselectedNote: preselected,
  });

  const structuredOutput = input.profile.mode === "provider_json_schema"
    ? { mode: "json_schema" as const, name: "task_route", schema, strict: true }
    : input.profile.mode === "provider_json_object"
      ? { mode: "json_object" as const, name: "task_route", schema }
      : {
          mode: "prompt_json" as const,
          name: "task_route",
          schema,
          sendJsonObjectHint: input.profile.requestHints.sendJsonObject,
        };

  return {
    model: input.model,
    messages: [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      ...input.messages.slice(-6),
      { role: "user", content: userContent },
    ],
    stream: false,
    maxTokens: 300,
    // Kimi k2.6 只允许 temperature=1，发 0 会被拒。
    // 省略让服务端用默认值，其他模型继续 temperature=0 保证确定性。
    ...(input.model.match(/^kimi-k2\.6(?:$|-)/i) ? {} : { temperature: 0 }),
    structuredOutput,
  };
}

// ── 主函数 ────────────────────────────────

export async function runTaskRouter(input: RunTaskRouterInput): Promise<TaskRoute> {
  // 1. 快捷路径：精确 Skill 匹配
  const matchedSkillId = matchSkillByName(input.originalQuery, input.availableSkills);
  if (matchedSkillId) {
    const skill = input.availableSkills.find((s) => s.id === matchedSkillId);
    if (skill?.defaultExecutionMode) {
      // Skill metadata 声明了执行模式，跳过 Router LLM
      return {
        executionMode: skill.defaultExecutionMode,
        skillIds: [matchedSkillId],
        reason: "用户指定技能 + metadata 声明模式",
      };
    }
    // metadata 没有声明，仍调用 Router，但预选 skillIds
    input = { ...input, preselectedSkillIds: [matchedSkillId] };
  }

  // 2. LLM 调用
  try {
    const result = await runStructuredOutput<TaskRoute, ChatRequest>({
      stage: "action_gate", // 复用 action_gate stage 的 repair 策略
      profile: input.profile,
      signal: input.signal,
      buildRequest: () => buildRouterRequest(input),
      generate: async (request, signal) => {
        const response = await input.generate(request, signal);
        return {
          text: response.text,
          finishReason: response.finishReason,
          refusal: response.refusal,
          structuredValue: response.structuredValue,
        };
      },
      parseSchema: parseTaskRoute,
      validateBusiness: (route) => {
        // 校验 skillIds 在可用列表中
        const validSkillIds = new Set(input.availableSkills.map((s) => s.id));
        const filtered = route.skillIds.filter((id) => validSkillIds.has(id));
        if (filtered.length < route.skillIds.length) {
          route = { ...route, skillIds: filtered };
        }
        // 如果有预选 skillIds，合并
        if (input.preselectedSkillIds) {
          const merged = new Set([...filtered, ...input.preselectedSkillIds]);
          route = { ...route, skillIds: [...merged] };
        }
        return { status: "accepted", value: route };
      },
    });

    if (result.outcome === "success") {
      return result.value;
    }
  } catch {
    // Router 失败，fallback to direct
  }

  // 3. Fallback: direct + 预选 skillIds（如有）
  return {
    executionMode: "direct",
    skillIds: input.preselectedSkillIds ?? [],
    reason: "Router fallback to direct",
  };
}

// ── 辅助：从 ToolDefinition 构建能力列表 ──

export function buildRouterCapabilities(tools: ToolDefinition[]): RunTaskRouterInput["availableCapabilities"] {
  return tools
    .filter((t) => t.enabled)
    .map((t) => ({
      capabilityId: t.capability ?? t.id,
      description: t.catalogHint?.trim() || t.description.split("\n")[0]?.trim() || t.description,
      hasCompletionEvidence: (t.completionEvidence?.length ?? 0) > 0,
    }));
}
