import { describe, expect, test, vi } from "vitest";
import { resolveStructuredOutputProfile } from "./profiles";
import { runStructuredOutput, type StructuredOutputRunInput } from "./runner";

interface Value {
  decision: string;
}

function baseInput(
  responses: Array<{
    text: string;
    finishReason?: string;
    refusal?: string;
    structuredValue?: unknown;
  } | Error>,
): StructuredOutputRunInput<Value, { attempt: number; minimal: boolean }> {
  let index = 0;
  return {
    stage: "task_router",
    profile: resolveStructuredOutputProfile({
      provider: "minimax",
      model: "MiniMax-M3",
      transport: "openai",
      endpointKind: "official",
    }),
    buildRequest: ({ attempt, minimal }) => ({ attempt, minimal }),
    generate: async () => {
      const response = responses[index++] ?? responses[responses.length - 1];
      if (response instanceof Error) throw response;
      return response;
    },
    parseSchema: (candidate) => {
      const value = candidate as Partial<Value>;
      if (typeof value.decision !== "string") throw new Error("missing decision");
      return { decision: value.decision };
    },
    validateBusiness: (value) => ({ status: "accepted", value }),
  };
}

describe("runStructuredOutput", () => {
  test("returns the unique schema-valid and business-trusted object", async () => {
    const result = await runStructuredOutput(baseInput([
      { text: '{"decision":"respond"}', finishReason: "stop" },
    ]));
    expect(result).toMatchObject({
      outcome: "success",
      value: { decision: "respond" },
      attempts: 1,
      repairCount: 0,
    });
  });

  test("uses LangChain's parsed value without running legacy JSON candidate extraction", async () => {
    const input = baseInput([{
      text: "this text is deliberately not JSON",
      finishReason: "stop",
      structuredValue: { decision: "respond" },
    }]);
    const parseSchema = vi.fn(input.parseSchema);
    input.parseSchema = parseSchema;

    const result = await runStructuredOutput(input);

    expect(result).toMatchObject({
      outcome: "success",
      value: { decision: "respond" },
      attempts: 1,
    });
    expect(parseSchema).toHaveBeenCalledWith({ decision: "respond" });
  });

  test("repairs multiple schema-valid objects instead of choosing one", async () => {
    const input = baseInput([
      {
        text: '{"decision":"respond"}\n{"decision":"ask_user"}',
        finishReason: "stop",
      },
      { text: '{"decision":"ask_user"}', finishReason: "stop" },
    ]);
    const result = await runStructuredOutput(input);
    expect(result).toMatchObject({
      outcome: "success",
      value: { decision: "ask_user" },
      attempts: 2,
      repairCount: 1,
    });
  });

  test("repairs a truncated response and uses the minimal request on repair two", async () => {
    const seen: Array<{ attempt: number; minimal: boolean }> = [];
    const input = baseInput([
      { text: '{"decision":', finishReason: "length" },
      { text: "not json", finishReason: "stop" },
      { text: '{"decision":"respond"}', finishReason: "stop" },
    ]);
    input.generate = async (request) => {
      seen.push(request);
      const responses = [
        { text: '{"decision":', finishReason: "length" },
        { text: "not json", finishReason: "stop" },
        { text: '{"decision":"respond"}', finishReason: "stop" },
      ];
      return responses[seen.length - 1];
    };
    const result = await runStructuredOutput(input);
    expect(result.outcome).toBe("success");
    expect(seen).toEqual([
      { attempt: 0, minimal: false },
      { attempt: 1, minimal: false },
      { attempt: 2, minimal: true },
    ]);
  });

  test("does not repair business errors classified for another disposition", async () => {
    const input = baseInput([{ text: '{"decision":"act"}', finishReason: "stop" }]);
    const generate = vi.fn(input.generate);
    input.generate = generate;
    input.validateBusiness = () => ({
      status: "rejected",
      error: { layer: "business", code: "STATE_EXPIRED", disposition: "refresh_state" },
    });
    const result = await runStructuredOutput(input);
    expect(result).toMatchObject({
      outcome: "failure",
      failure: { code: "STATE_EXPIRED", disposition: "refresh_state", toolExecuted: false },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ text: "", finishReason: "content_filter" }, "CONTENT_FILTERED"],
    [{ text: "", finishReason: "stop", refusal: "no" }, "REFUSED"],
    [new Error("offline"), "MODEL_REQUEST_FAILED"],
  ] as const)("fails closed without protocol repair for %s", async (response, code) => {
    const input = baseInput([response]);
    const generate = vi.fn(input.generate);
    input.generate = generate;
    const result = await runStructuredOutput(input);
    expect(result).toMatchObject({
      outcome: "failure",
      failure: { code, disposition: "fail_closed", toolExecuted: false },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("returns explicit failure after exhausting two repairs", async () => {
    const result = await runStructuredOutput(baseInput([
      { text: "bad", finishReason: "stop" },
      { text: "still bad", finishReason: "stop" },
      { text: "again bad", finishReason: "stop" },
    ]));
    expect(result).toMatchObject({
      outcome: "failure",
      failure: {
        code: "REPAIR_EXHAUSTED",
        attempts: 3,
        toolExecuted: false,
      },
    });
  });
});
