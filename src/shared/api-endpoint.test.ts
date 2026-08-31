import { describe, expect, it } from "vitest";
import { resolveApiEndpoint } from "./api-endpoint";

describe("resolveApiEndpoint", () => {
  it("appends the OpenAI Chat Completions suffix", () => {
    expect(resolveApiEndpoint("https://api.deepseek.com", "openai")).toEqual({
      url: "https://api.deepseek.com/chat/completions",
      appendedSuffix: "/chat/completions",
    });
  });

  it("does not duplicate a complete OpenAI endpoint", () => {
    expect(resolveApiEndpoint("https://api.deepseek.com/chat/completions/", "openai")).toEqual({
      url: "https://api.deepseek.com/chat/completions",
      appendedSuffix: null,
    });
  });

  it("appends only /messages when an Anthropic base URL already ends in /v1", () => {
    expect(resolveApiEndpoint("https://api.anthropic.com/v1", "anthropic")).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      appendedSuffix: "/messages",
    });
  });

  it("appends /v1/messages to an Anthropic host or compatibility prefix", () => {
    expect(resolveApiEndpoint("https://example.com/anthropic", "anthropic")).toEqual({
      url: "https://example.com/anthropic/v1/messages",
      appendedSuffix: "/v1/messages",
    });
  });

  it("does not duplicate a complete Anthropic endpoint", () => {
    expect(resolveApiEndpoint("https://api.anthropic.com/v1/messages", "anthropic")).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      appendedSuffix: null,
    });
  });

  it("appends /responses to a versioned OpenAI base URL", () => {
    expect(resolveApiEndpoint("https://api.openai.com/v1", "responses")).toEqual({
      url: "https://api.openai.com/v1/responses",
      appendedSuffix: "/responses",
    });
  });

  it("appends /responses to a third-party versioned base URL (Ark /v3)", () => {
    expect(resolveApiEndpoint("https://ark.cn-beijing.volces.com/api/v3", "responses")).toEqual({
      url: "https://ark.cn-beijing.volces.com/api/v3/responses",
      appendedSuffix: "/responses",
    });
  });

  it("appends /responses to a bare DeepSeek host", () => {
    expect(resolveApiEndpoint("https://api.deepseek.com", "responses")).toEqual({
      url: "https://api.deepseek.com/responses",
      appendedSuffix: "/responses",
    });
  });

  it("does not duplicate a complete Responses endpoint", () => {
    expect(resolveApiEndpoint("https://api.openai.com/v1/responses/", "responses")).toEqual({
      url: "https://api.openai.com/v1/responses",
      appendedSuffix: null,
    });
  });
});
