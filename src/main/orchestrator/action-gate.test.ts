import { describe, expect, it, vi } from "vitest";
import {
  buildActionGateRequest,
  parseActionDecisionValue,
  runActionGate,
  type ActionCapability,
  type RunActionGateInput,
} from "./action-gate";
import { resolveStructuredOutputProfile } from "./structured-output/profiles";
import type { ChatResponse } from "./vendors/types";

const capabilities: ActionCapability[] = [{
  capability: "music.play_track",
  toolId: "music_play_track",
  description: "播放歌曲",
  requiredInputs: ["candidateRef"],
  referencePolicy: "context_ref",
}];

const schemaProfile = resolveStructuredOutputProfile({
  provider: "chatgpt",
  model: "gpt-5.2",
  transport: "openai",
  endpointKind: "official",
});

const promptProfile = resolveStructuredOutputProfile({
  provider: "custom-provider",
  model: "local-model",
  transport: "openai",
  endpointKind: "custom",
});

function response(value: unknown, overrides: Partial<ChatResponse> = {}): ChatResponse {
  const text = JSON.stringify(value);
  return {
    assistantMessage: { role: "assistant", content: text },
    text,
    toolCalls: [],
    finishReason: "stop",
    raw: {},
    ...overrides,
  };
}

function actDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: "act",
    capability: "music.play_track",
    objective: "播放当前候选中的第一首",
    targetRefs: ["ctx-song-1"],
    afterSuccess: "respond",
    ...overrides,
  };
}

function baseInput(
  generate: RunActionGateInput["generate"],
  overrides: Partial<RunActionGateInput> = {},
): RunActionGateInput {
  return {
    model: "gpt-5.2",
    originalQuery: "播放第一首",
    contextualizedQuery: "播放当前候选中的第一首",
    citaContextBlock: "[CITA_CONTEXT]trusted[/CITA_CONTEXT]",
    messages: [{ role: "user", content: "播放第一首" }],
    availableCapabilities: capabilities,
    trustedRefs: ["ctx-song-1"],
    toolResults: [],
    profile: schemaProfile,
    generate,
    validateTargetRef: (ref) => ref === "ctx-song-1",
    ...overrides,
  };
}

describe("buildActionGateRequest", () => {
  it("includes trusted runtime defaults and machine-derived required inputs", () => {
    const request = buildActionGateRequest(({
      ...baseInput(async () => response({ decision: "respond", reason: "done" })),
      runtimeEnvironmentContext: "默认城市：淄博\n桌面：C:\\Users\\13575\\Desktop",
      availableCapabilities: [{
        ...capabilities[0],
        requiredInputs: ["candidateRef"],
      }],
      repair: { attempt: 0, minimal: false, errors: [] },
    } as unknown) as Parameters<typeof buildActionGateRequest>[0]);
    const payload = JSON.parse(String(request.messages.at(-1)?.content));

    expect(payload.machineInput.runtimeEnvironmentContext).toContain("默认城市：淄博");
    expect(payload.machineInput.availableCapabilities[0].requiredInputs).toEqual(["candidateRef"]);
  });

  it("uses provider JSON Schema without declaring a virtual decision tool", () => {
    const request = buildActionGateRequest({
      ...baseInput(async () => response({ decision: "respond", reason: "done" })),
      repair: { attempt: 0, minimal: false, errors: [] },
    });

    expect(request.tools).toBeUndefined();
    expect(request.toolChoiceOverride).toBeUndefined();
    expect(request.structuredOutput).toMatchObject({
      mode: "json_schema",
      name: "action_decision",
      strict: true,
    });
  });

  it("keeps custom and local models on fixed prompt_json mode", () => {
    const request = buildActionGateRequest({
      ...baseInput(async () => response({ decision: "respond", reason: "done" }), {
        profile: promptProfile,
        model: "local-model",
      }),
      repair: { attempt: 0, minimal: false, errors: [] },
    });

    expect(request.structuredOutput).toMatchObject({
      mode: "prompt_json",
      name: "action_decision",
      schema: expect.any(Object),
      sendJsonObjectHint: false,
    });
    expect(String(request.messages.at(-1)?.content)).toContain('"outputSchema"');
  });

  it("uses the minimal trusted input on the second repair", () => {
    const request = buildActionGateRequest({
      ...baseInput(async () => response({ decision: "respond", reason: "done" })),
      repair: {
        attempt: 2,
        minimal: true,
        errors: [{ layer: "schema", code: "NO_SCHEMA_VALID_OBJECT", disposition: "repair" }],
      },
    });
    const payload = JSON.parse(String(request.messages.at(-1)?.content)) as Record<string, unknown>;

    expect(payload).toMatchObject({
      protocol: "action_gate.decision.v1",
      rewrittenQuery: "播放当前候选中的第一首",
      trustedRefs: ["ctx-song-1"],
      repair: { attempt: 2, errorCodes: ["NO_SCHEMA_VALID_OBJECT"] },
    });
    expect(payload).not.toHaveProperty("originalQuery");
    expect(payload).not.toHaveProperty("toolResults");
  });
});

describe("runActionGate", () => {
  it("accepts and discards a harmless explanatory reason on an act decision", () => {
    expect(parseActionDecisionValue({
      decision: "act",
      capability: "music.play_track",
      objective: "播放当前候选中的第一首",
      targetRefs: ["ctx-song-1"],
      afterSuccess: "respond",
      reason: "目标、能力和引用已经明确，可以执行。",
      missingFields: [],
    })).toEqual({
      decision: "act",
      capability: "music.play_track",
      objective: "播放当前候选中的第一首",
      targetRefs: ["ctx-song-1"],
      afterSuccess: "respond",
    });
  });

  it("returns a trusted act decision only after schema and business validation", async () => {
    const generate = vi.fn(async () => response(actDecision()));

    const result = await runActionGate(baseInput(generate));

    expect(result).toEqual({
      outcome: "success",
      decision: actDecision(),
      repairCount: 0,
    });
  });

  it("repairs a schema-invalid response using error codes without echoing raw output", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(response({ decision: "act", capability: "music.play_track" }))
      .mockResolvedValueOnce(response({ decision: "respond", reason: "无需工具" }));

    const result = await runActionGate(baseInput(generate));

    expect(result).toMatchObject({
      outcome: "success",
      decision: { decision: "respond", reason: "无需工具" },
      repairCount: 1,
    });
    const repairPayload = String(generate.mock.calls[1][0].messages.at(-1)?.content);
    expect(repairPayload).toContain("NO_SCHEMA_VALID_OBJECT");
    expect(repairPayload).not.toContain('"decision":"act"');
  });

  it("repairs when more than one distinct schema-valid decision is returned", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(response({}, {
        text: `${JSON.stringify({ decision: "respond", reason: "a" })}\n${JSON.stringify({ decision: "respond", reason: "b" })}`,
      }))
      .mockResolvedValueOnce(response({ decision: "respond", reason: "ok" }));

    const result = await runActionGate(baseInput(generate));

    expect(result).toMatchObject({ outcome: "success", repairCount: 1 });
    expect(String(generate.mock.calls[1][0].messages.at(-1)?.content))
      .toContain("AMBIGUOUS_MULTIPLE_VALID_OBJECTS");
  });

  it("repairs a capability not present in the current available set", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(response(actDecision({ capability: "shell.execute" })))
      .mockResolvedValueOnce(response({ decision: "respond", reason: "能力不可用" }));

    const result = await runActionGate(baseInput(generate));

    expect(result).toMatchObject({ outcome: "success", repairCount: 1 });
    expect(String(generate.mock.calls[1][0].messages.at(-1)?.content))
      .toContain("CAPABILITY_UNAVAILABLE");
  });

  it("classifies an unknown or stale target ref as refresh_state and fails closed", async () => {
    const generate = vi.fn(async () => response(actDecision({ targetRefs: ["stale-ref"] })));

    const result = await runActionGate(baseInput(generate));

    expect(result).toEqual({
      outcome: "failure",
      failure: {
        stage: "action_gate",
        code: "TARGET_REF_INVALID",
        disposition: "refresh_state",
        toolExecuted: false,
      },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("discards invented target refs for a capability that does not use context refs", async () => {
    const generate = vi.fn(async () => response(actDecision({
      capability: "weather.lookup",
      objective: "查询杭州天气",
      targetRefs: ["杭州"],
    })));

    const result = await runActionGate(baseInput(generate, {
      originalQuery: "查一下杭州天气",
      contextualizedQuery: "查询杭州当前天气",
      availableCapabilities: [{
        capability: "weather.lookup",
        toolId: "weather",
        description: "查询天气",
        requiredInputs: [],
        referencePolicy: "none",
      } as ActionCapability],
      trustedRefs: [],
      validateTargetRef: () => false,
    }));

    expect(result).toEqual({
      outcome: "success",
      decision: {
        decision: "act",
        capability: "weather.lookup",
        objective: "查询杭州天气",
        targetRefs: [],
        afterSuccess: "respond",
      },
      repairCount: 0,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("accepts structured ask_user fields and candidate choices", async () => {
    const generate = vi.fn(async () => response({
      decision: "ask_user",
      reason: "需要确认文档主题和格式",
      missingFields: [
        {
          field: "topic",
          reason: "文档内容未知",
          required: true,
          questionHint: "这份文档主要写什么？",
          typeHint: "text",
          candidateHints: ["项目说明", "学习总结"],
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
          ],
          allowCustom: true,
        },
      ],
    }));

    const result = await runActionGate(baseInput(generate));

    expect(result).toMatchObject({
      outcome: "success",
      decision: {
        decision: "ask_user",
        reason: "需要确认文档主题和格式",
        missingFields: [
          expect.objectContaining({ field: "topic", typeHint: "text" }),
          expect.objectContaining({
            field: "format",
            typeHint: "single_select",
            allowedOptions: [
              { value: "word", label: "Word 文档" },
              { value: "markdown", label: "Markdown 文档" },
            ],
          }),
        ],
      },
    });
  });

  it("fails closed on refusal and never reports tool execution", async () => {
    const generate = vi.fn(async () => response({}, { text: "", refusal: "policy" }));

    const result = await runActionGate(baseInput(generate));

    expect(result).toMatchObject({
      outcome: "failure",
      failure: { code: "REFUSED", toolExecuted: false },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("returns a local trusted failure fact after repair exhaustion", async () => {
    const generate = vi.fn(async () => response({ invalid: true }));

    const result = await runActionGate(baseInput(generate));

    expect(result).toEqual({
      outcome: "failure",
      failure: {
        stage: "action_gate",
        code: "REPAIR_EXHAUSTED",
        disposition: "fail_closed",
        toolExecuted: false,
      },
    });
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
