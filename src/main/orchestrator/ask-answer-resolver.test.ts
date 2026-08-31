import { describe, expect, it } from "vitest";
import type { AskUserAnswer } from "../../shared/ask-clarification";
import type { ToolDefinition } from "./tool-registry";
import {
  buildPendingAskInput,
  createPendingAction,
  resolvePendingActionAnswers,
} from "./ask-answer-resolver";

function documentTool(): ToolDefinition {
  return {
    id: "write_document",
    capability: "document.write",
    name: "生成文档",
    description: "生成指定格式的文档",
    enabled: true,
    effectKind: "mutation",
    verificationPolicy: "artifact",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        format: { type: "string", enum: ["docx", "pdf", "md"] },
        copies: { type: "integer" },
      },
      required: ["title", "format", "copies"],
    },
    execute: async () => "unused",
  };
}

function answer(items: AskUserAnswer["answers"]): AskUserAnswer {
  return { requestId: "ask-1", answers: items };
}

describe("AskAnswerResolver", () => {
  it("derives safe Ask candidates from schema metadata rather than model bindings", () => {
    const tool = documentTool();
    const pending = createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: { title: "今日新闻" },
      missingFields: ["format", "copies"],
      context: { runId: "run-1" },
      createdAt: 100,
    });

    expect(buildPendingAskInput(pending, tool, "生成今日新闻报告")).toEqual({
      userRequest: "生成今日新闻报告",
      missingFields: [
        expect.objectContaining({
          field: "format",
          typeHint: "single_select",
          allowedOptions: [
            { label: "docx", value: "docx" },
            { label: "pdf", value: "pdf" },
            { label: "md", value: "md" },
          ],
        }),
        expect.objectContaining({ field: "copies", typeHint: "text", allowedOptions: undefined }),
      ],
    });
  });

  it("derives bindings from the selected tool schema and resumes with canonical answers", () => {
    const tool = documentTool();
    const pending = createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: { title: "今日新闻" },
      missingFields: ["format", "copies"],
      context: { runId: "run-1", planId: "plan-1", stepId: "step-1", stepAttemptId: "attempt-1" },
      createdAt: 100,
    });

    expect(pending.bindings).toEqual({ format: "format", copies: "copies" });
    const resolution = resolvePendingActionAnswers({
      pendingAction: pending,
      currentTool: tool,
      answer: answer([
        { field: "format", selectedValues: ["pdf"] },
        { field: "copies", customText: "2" },
      ]),
      currentContext: { runId: "run-1", planId: "plan-1", stepId: "step-1", stepAttemptId: "attempt-1" },
      toolResults: [],
    });

    expect(resolution).toEqual({
      kind: "resume_action",
      action: expect.objectContaining({
        toolId: "write_document",
        args: { title: "今日新闻", format: "pdf", copies: 2 },
      }),
    });
  });

  it("returns semantic and ambiguous custom answers to the agent", () => {
    const tool = documentTool();
    const pending = createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: { title: "今日新闻", copies: 1 },
      missingFields: ["format"],
      context: { runId: "run-1" },
      createdAt: 100,
    });

    expect(resolvePendingActionAnswers({
      pendingAction: pending,
      currentTool: tool,
      answer: answer([{ field: "format", customText: "做成适合朋友圈的东西" }]),
      currentContext: { runId: "run-1" },
      toolResults: [],
    })).toEqual(expect.objectContaining({
      kind: "return_to_agent",
      reason: "normalization_failed",
    }));
  });

  it("normalizes a custom answer only through aliases declared by Runtime", () => {
    const tool = documentTool();
    tool.inputSchema.properties.format = {
      type: "string",
      enum: ["docx", "pdf", "md"],
      askAliases: { Word: "docx", Markdown: "md" },
    };
    const pending = createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: { title: "今日新闻", copies: 1 },
      missingFields: ["format"],
      context: { runId: "run-1" },
      createdAt: 100,
    });

    expect(resolvePendingActionAnswers({
      pendingAction: pending,
      currentTool: tool,
      answer: answer([{ field: "format", customText: " word " }]),
      currentContext: { runId: "run-1" },
      toolResults: [],
    })).toEqual({
      kind: "resume_action",
      action: expect.objectContaining({ args: { title: "今日新闻", copies: 1, format: "docx" } }),
    });
  });

  it("rejects a changed schema and a stale run before execution", () => {
    const tool = documentTool();
    const pending = createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: { title: "今日新闻", copies: 1 },
      missingFields: ["format"],
      context: { runId: "run-1" },
      createdAt: 100,
    });
    const validAnswer = answer([{ field: "format", selectedValues: ["docx"] }]);

    expect(resolvePendingActionAnswers({
      pendingAction: pending,
      currentTool: tool,
      answer: validAnswer,
      currentContext: { runId: "run-2" },
      toolResults: [],
    })).toEqual(expect.objectContaining({ kind: "return_to_agent", reason: "stale_pending_action" }));

    const changedTool = documentTool();
    changedTool.inputSchema.properties.format = { type: "string", enum: ["txt", "md"] };
    expect(resolvePendingActionAnswers({
      pendingAction: pending,
      currentTool: changedTool,
      answer: validAnswer,
      currentContext: { runId: "run-1" },
      toolResults: [],
    })).toEqual(expect.objectContaining({ kind: "return_to_agent", reason: "schema_validation_failed" }));
  });

  it("refuses mixed, unknown, or non-primitive bindings", () => {
    const tool = documentTool();
    tool.inputSchema.properties.metadata = {
      type: "object",
      properties: { audience: { type: "string" } },
      required: ["audience"],
    };
    tool.inputSchema.required?.push("metadata");

    expect(() => createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: {},
      missingFields: ["format", "favoriteFruit"],
      context: { runId: "run-1" },
      createdAt: 100,
    })).toThrow("E_PENDING_ACTION_BINDING_INVALID");

    expect(() => createPendingAction({
      tool,
      capability: "document.write",
      objective: "生成报告",
      targetRefs: [],
      afterSuccess: "respond",
      argumentsSnapshot: {},
      missingFields: ["metadata"],
      context: { runId: "run-1" },
      createdAt: 100,
    })).toThrow("E_PENDING_ACTION_BINDING_UNSUPPORTED");
  });
});
