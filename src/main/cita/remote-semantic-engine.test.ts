import { describe, expect, it, vi } from "vitest";
import type { TurnUnderstanding, TurnUnderstandingInput } from "./contracts";
import { RemoteSemanticEngine } from "./remote-semantic-engine";
import type { SemanticGeneratorResult, SemanticTextGenerator } from "./semantic-engine";
import { resolveStructuredOutputProfile } from "../orchestrator/structured-output/profiles";

const input: TurnUnderstandingInput = {
  conversationId: "conversation-a",
  turnId: "turn-2",
  stateRevision: 3,
  originalQuery: "第一首吧",
  availableContexts: [{
    contextRef: "music-candidate-1",
    conversationId: "conversation-a",
    domain: "music",
    kind: "candidate",
    label: "胆小鬼 - 梁咏琪",
    position: 1,
    presented: true,
    lifecycle: "active",
    source: "tool_result",
  }],
  recentDialogue: [{ role: "assistant", text: "想听哪一首？" }],
  recentEvents: [],
};

const profile = resolveStructuredOutputProfile({
  provider: "chatgpt",
  model: "gpt-5.2",
  transport: "openai",
  endpointKind: "official",
});

function understanding(
  overrides: Partial<TurnUnderstanding> = {},
): TurnUnderstanding {
  return {
    contextualizedQuery: "用户选择当前歌曲候选中的第一首《胆小鬼》。",
    rewriteStatus: "rewritten",
    resolvedReferences: [{
      surface: "第一首",
      targetRef: "music-candidate-1",
      relation: "candidate_position",
    }],
    focusedEntityRefs: ["music-candidate-1"],
    ...overrides,
  };
}

function generated(
  value: unknown = understanding(),
  overrides: Partial<SemanticGeneratorResult> = {},
): SemanticGeneratorResult {
  return {
    text: JSON.stringify(value),
    finishReason: "stop",
    ...overrides,
  };
}

describe("RemoteSemanticEngine (Structured Output)", () => {
  it("requests schema output without virtual tools and returns trusted understanding", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => generated());
    const engine = new RemoteSemanticEngine(generate, { profile });

    const result = await engine.understandTurn(input);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(generate.mock.calls[0][0]).not.toHaveProperty("toolChoice");
    expect(generate.mock.calls[0][0].structuredOutput).toMatchObject({
      mode: "json_schema",
      name: "cita_turn_understanding",
      strict: true,
    });
    expect(result).toEqual(understanding());
  });

  it("extracts a fenced JSON object through the shared pipeline", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => ({
      text: `analysis\n\`\`\`json\n${JSON.stringify(understanding())}\n\`\`\``,
      finishReason: "end_turn",
    }));
    const engine = new RemoteSemanticEngine(generate, { profile });

    await expect(engine.understandTurn(input)).resolves.toEqual(understanding());
  });

  it("repairs a schema-invalid result with structured error codes only", async () => {
    const generate = vi.fn<SemanticTextGenerator>()
      .mockResolvedValueOnce(generated({ contextualizedQuery: "缺字段" }))
      .mockResolvedValueOnce(generated());
    const engine = new RemoteSemanticEngine(generate, { profile });

    await expect(engine.understandTurn(input)).resolves.toEqual(understanding());
    expect(generate).toHaveBeenCalledTimes(2);
    const repairPayload = JSON.parse(generate.mock.calls[1][0].userPrompt) as {
      repair: { errorCodes: string[] };
    };
    expect(repairPayload.repair.errorCodes).toEqual(["NO_SCHEMA_VALID_OBJECT"]);
    expect(generate.mock.calls[1][0].userPrompt).not.toContain("缺字段");
  });

  it("rejects multiple distinct schema-valid objects and repairs", async () => {
    const alternative = understanding({ contextualizedQuery: "另一个有效对象" });
    const generate = vi.fn<SemanticTextGenerator>()
      .mockResolvedValueOnce({
        text: `${JSON.stringify(understanding())}\n${JSON.stringify(alternative)}`,
        finishReason: "stop",
      })
      .mockResolvedValueOnce(generated());
    const engine = new RemoteSemanticEngine(generate, { profile });

    await expect(engine.understandTurn(input)).resolves.toEqual(understanding());
    const repairPayload = JSON.parse(generate.mock.calls[1][0].userPrompt) as {
      repair: { errorCodes: string[] };
    };
    expect(repairPayload.repair.errorCodes).toEqual(["AMBIGUOUS_MULTIPLE_VALID_OBJECTS"]);
  });

  it("drops unknown references and returns the deterministic degraded understanding", async () => {
    const candidate = understanding({
      resolvedReferences: [
        ...understanding().resolvedReferences,
        { surface: "那个", targetRef: "invented-ref", relation: "direct" },
      ],
      focusedEntityRefs: ["music-candidate-1", "invented-ref"],
    });
    const generate = vi.fn<SemanticTextGenerator>(async () => generated(candidate));
    const engine = new RemoteSemanticEngine(generate, { profile });

    const result = await engine.understandTurn(input);

    expect(result.resolvedReferences).toEqual(understanding().resolvedReferences);
    expect(result.focusedEntityRefs).toEqual(["music-candidate-1"]);
    expect(result.contextualizedQuery).toBe(input.originalQuery);
    expect(result.rewriteStatus).toBe("insufficient_context");
  });

  it("drops cross-conversation, expired and unpresented references", async () => {
    const invalidContexts: TurnUnderstandingInput["availableContexts"] = [
      {
        contextRef: "cross-ref",
        conversationId: "conversation-b",
        domain: "music",
        kind: "candidate",
        label: "其他会话",
        position: 2,
        presented: true,
        lifecycle: "active",
        source: "tool_result",
      },
      {
        contextRef: "expired-ref",
        conversationId: "conversation-a",
        domain: "music",
        kind: "candidate",
        label: "过期候选",
        position: 3,
        presented: true,
        lifecycle: "expired",
        source: "tool_result",
      },
      {
        contextRef: "hidden-ref",
        conversationId: "conversation-a",
        domain: "music",
        kind: "candidate",
        label: "未展示候选",
        position: 4,
        presented: false,
        lifecycle: "active",
        source: "tool_result",
      },
    ];
    const candidate = understanding({
      resolvedReferences: invalidContexts.map((context) => ({
        surface: context.label,
        targetRef: context.contextRef,
        relation: "direct" as const,
      })),
      focusedEntityRefs: invalidContexts.map((context) => context.contextRef),
    });
    const generate = vi.fn<SemanticTextGenerator>(async () => generated(candidate));
    const engine = new RemoteSemanticEngine(generate, { profile });

    const result = await engine.understandTurn({
      ...input,
      availableContexts: [...input.availableContexts, ...invalidContexts],
    });

    expect(result.resolvedReferences).toEqual([]);
    expect(result.focusedEntityRefs).toEqual([]);
    expect(result.contextualizedQuery).toBe(input.originalQuery);
    expect(result.rewriteStatus).toBe("insufficient_context");
  });

  it("fails closed on refusal without attempting repair", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => generated(undefined, {
      text: "",
      refusal: "policy",
    }));
    const engine = new RemoteSemanticEngine(generate, { profile });

    await expect(engine.understandTurn(input)).rejects.toThrow(/REFUSED/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("aborts a semantic call that exceeds its time budget", async () => {
    vi.useFakeTimers();
    const onAbort = vi.fn();
    const generate = vi.fn<SemanticTextGenerator>(
      (_request, signal?: AbortSignal) => new Promise<SemanticGeneratorResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          onAbort();
          reject(new Error("aborted"));
        }, { once: true });
      }),
    );
    const engine = new RemoteSemanticEngine(generate, { profile });

    try {
      const rejection = expect(engine.understandTurn(input)).rejects.toThrow(/MODEL_REQUEST_TIMEOUT/);
      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(generate).toHaveBeenCalledTimes(1);
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
