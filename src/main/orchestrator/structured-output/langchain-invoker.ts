import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import type {
  ChatMessage,
  ChatRequest,
  VendorConfig,
} from "../vendors/types";

interface StructuredAgent {
  invoke(
    input: { messages: unknown[] },
    config?: { signal?: AbortSignal; recursionLimit?: number },
  ): Promise<{
    structuredResponse?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
}

interface LangChainStructuredDependencies {
  createModel?: (request: ChatRequest, config: VendorConfig) => BaseChatModel;
  createAgent?: (options: {
    model: BaseChatModel;
    tools: [];
    systemPrompt?: string;
    responseFormat: object;
  }) => StructuredAgent;
}

function isAnthropic(config: VendorConfig): boolean {
  return config.explicitTransport === "anthropic" || config.provider === "claude";
}

function isDeepSeek(config: VendorConfig): boolean {
  return config.provider === "deepseek";
}

function createModel(request: ChatRequest, config: VendorConfig): BaseChatModel {
  if (isAnthropic(config)) {
    return new ChatAnthropic({
      model: request.model,
      apiKey: config.apiKey,
      anthropicApiUrl: config.baseUrl,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
    });
  }
  if (isDeepSeek(config)) {
    return new ChatDeepSeek({
      model: request.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      frequencyPenalty: request.frequencyPenalty,
      modelKwargs: request.extraBody,
      streaming: false,
    });
  }
  return new ChatOpenAI({
    model: request.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    frequencyPenalty: request.frequencyPenalty,
    modelKwargs: request.extraBody,
    streaming: false,
  });
}

function systemPromptOf(messages: ChatMessage[]): string | undefined {
  const prompts = messages
    .filter((message) => message.role === "system")
    .map((message) => (
      typeof message.content === "string" ? message.content.trim() : ""
    ))
    .filter((content): content is string => Boolean(content));
  return prompts.length > 0 ? prompts.join("\n\n") : undefined;
}

function inputMessagesOf(messages: ChatMessage[]): unknown[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          content: message.content ?? "",
          tool_call_id: message.toolCallId,
          ...(message.name ? { name: message.name } : {}),
        };
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        };
      }
      return {
        role: message.role,
        content: message.content ?? "",
      };
    });
}

export async function invokeLangChainStructured(
  request: ChatRequest,
  config: VendorConfig,
  signal?: AbortSignal,
  dependencies: LangChainStructuredDependencies = {},
): Promise<{
  text: string;
  finishReason: string;
  structuredValue: Record<string, unknown>;
}> {
  const schema = request.structuredOutput?.schema;
  if (!schema) throw new Error("LANGCHAIN_STRUCTURED_SCHEMA_MISSING");

  const modelFactory = dependencies.createModel ?? createModel;
  const agentFactory = dependencies.createAgent ?? ((options) => {
    const agent = createAgent(options);
    return {
      invoke: async (input, invokeConfig) => (
        await agent.invoke(input as never, invokeConfig)
      ) as { structuredResponse?: Record<string, unknown> },
    };
  });
  const agent = agentFactory({
    model: modelFactory(request, config),
    tools: [],
    systemPrompt: systemPromptOf(request.messages),
    responseFormat: schema,
  });
  const result = await agent.invoke(
    { messages: inputMessagesOf(request.messages) },
    { signal, recursionLimit: 6 },
  );
  if (!result.structuredResponse) {
    throw new Error("LANGCHAIN_STRUCTURED_RESPONSE_MISSING");
  }
  return {
    text: JSON.stringify(result.structuredResponse),
    finishReason: "stop",
    structuredValue: result.structuredResponse,
  };
}
