import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { ChatRequest, ChatResponse, ToolCall } from "./vendors/types";

export interface NativeToolCallInput {
  model: string;
  nativeFcSystemPrompt: string;
  executionBrief: string;
  /** 本地主进程提供的可信默认值与绝对路径。 */
  runtimeEnvironmentContext?: string;
  toolResults: ToolCallResult[];
  tool: ToolDefinition;
  protocolFeedback?: string;
}

type InvokeNativeModel = (request: ChatRequest) => Promise<ChatResponse>;

function directToolCall(tool: ToolDefinition): ToolCall {
  return { id: `${tool.id}-${Date.now()}`, name: tool.id, arguments: "{}" };
}

function buildRequest(input: NativeToolCallInput): ChatRequest {
  const systemContent = [
    input.nativeFcSystemPrompt,
    input.runtimeEnvironmentContext
      ? `[TRUSTED_RUNTIME_ENVIRONMENT]\n${input.runtimeEnvironmentContext}\n[/TRUSTED_RUNTIME_ENVIRONMENT]`
      : "",
    input.executionBrief,
    buildToolExecutionContext(input.toolResults),
    input.protocolFeedback ? `上一次工具参数未通过 Runtime 校验：${input.protocolFeedback}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    model: input.model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "请根据 EXECUTION_BRIEF 填写工具参数。" },
    ],
    tools: [{
      name: input.tool.id,
      description: input.tool.description,
      parameters: {
        type: "object",
        properties: input.tool.inputSchema.properties,
        ...(input.tool.inputSchema.required ? { required: input.tool.inputSchema.required } : {}),
      },
    }],
    toolChoiceIntent: { mode: "must_call", toolName: input.tool.id },
    stream: false,
  };
}

export async function resolveNativeToolCall(
  input: NativeToolCallInput,
  invoke: InvokeNativeModel,
): Promise<ToolCall> {
  if (Object.keys(input.tool.inputSchema.properties).length === 0) return directToolCall(input.tool);
  const response = await invoke(buildRequest(input));

  // 脱敏诊断：记录模型返回的原始结构，不打印 arguments 内容
  const finishReason = response.finishReason ?? "unknown";
  const toolCallCount = response.toolCalls.length;
  const toolCallNames = response.toolCalls.map((tc) => tc.name);
  const hasText = typeof response.text === "string" && response.text.length > 0;
  const textLength = hasText ? response.text.length : 0;
  const hasRefusal = !!response.refusal;

  console.log(`[NativeFC] tool=${input.tool.id} finish=${finishReason} toolCalls=${toolCallCount} names=[${toolCallNames.join(", ")}] textLen=${textLength} refusal=${hasRefusal}`);

  if (toolCallCount >= 1 && response.toolCalls[0].name === input.tool.id) {
    // MiniMax 等模型在 must_call 模式下可能返回多个同名 tool call
    // 取第一个，其余忽略
    if (toolCallCount > 1) {
      console.warn(`[NativeFC] tool=${input.tool.id} received ${toolCallCount} calls, using first one`);
    }
    // 记录 arguments 的结构信息（不打印内容）
    const args = response.toolCalls[0].arguments;
    let argsType = "string";
    let argsLen = 0;
    let argsParsed = false;
    if (typeof args === "string") {
      argsLen = args.length;
      try { JSON.parse(args); argsParsed = true; } catch { /* not valid JSON */ }
    } else {
      argsType = typeof args;
    }
    console.log(`[NativeFC] accepted: tool=${input.tool.id} argsType=${argsType} argsLen=${argsLen} validJson=${argsParsed}`);
    return response.toolCalls[0];
  }

  // 分类失败原因
  let errorCode = "E_NATIVE_TOOL_PROTOCOL";
  let errorDetail = "unknown";
  if (toolCallCount === 0) {
    if (hasRefusal) {
      errorDetail = "MODEL_REFUSED";
    } else if (hasText) {
      errorDetail = "TEXT_INSTEAD_OF_TOOL_CALL";
      console.log(`[NativeFC] text response (first 200 chars): ${response.text!.slice(0, 200)}`);
    } else {
      errorDetail = "EMPTY_RESPONSE";
    }
  } else if (toolCallCount > 1) {
    errorDetail = "MULTIPLE_TOOL_CALLS";
  } else if (toolCallCount === 1 && response.toolCalls[0].name !== input.tool.id) {
    errorDetail = `WRONG_TOOL_NAME: expected=${input.tool.id} got=${response.toolCalls[0].name}`;
  }
  console.error(`[NativeFC] rejected: tool=${input.tool.id} detail=${errorDetail} finish=${finishReason}`);
  throw new Error(`${errorCode}:${errorDetail}`);
}
