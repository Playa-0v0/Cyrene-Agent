import { describe, it, expect } from "vitest";
import { resolveTransport } from "./transport-detector";

describe("resolveTransport（用户显式协议）", () => {
  it("用户显式 anthropic 优先于 baseUrl", () => {
    // baseUrl 是 /v1（启发式为 openai），但 explicitTransport="anthropic" 必须胜出
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/v1",
        explicitTransport: "anthropic",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("anthropic");
  });

  it("用户显式 openai 优先于 baseUrl", () => {
    // baseUrl 是 /anthropic（启发式为 anthropic），但 explicitTransport="openai" 必须胜出
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/anthropic",
        explicitTransport: "openai",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("openai");
  });

  it("旧 auto 值不再根据 Base URL 推断，回退到厂商默认协议", () => {
    expect(
      resolveTransport({
        baseUrl: "https://api.anthropic.com/v1",
        explicitTransport: "auto",
        provider: "Claude（Anthropic）",
      }),
    ).toBe("anthropic");
  });

  it("旧配置未保存协议时回退到厂商默认协议", () => {
    expect(
      resolveTransport({
        baseUrl: "https://api.deepseek.com",
        provider: "DeepSeek（深度求索）",
      }),
    ).toBe("openai");
  });

  it("MiniMax 新配置默认使用官方优先的 Anthropic 协议", () => {
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/anthropic",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("anthropic");
  });

  it("Base URL 路径不能覆盖厂商默认协议", () => {
    expect(
      resolveTransport({
        baseUrl: "https://proxy.example.com/v1",
        provider: "Claude（Anthropic）",
      }),
    ).toBe("anthropic");
  });

  it("用户显式 responses 优先于厂商默认协议", () => {
    expect(
      resolveTransport({
        baseUrl: "https://api.deepseek.com",
        explicitTransport: "responses",
        provider: "DeepSeek（深度求索）",
      }),
    ).toBe("responses");
  });

  it("显式 responses 与 auto 在同一档案下往返不丢值", () => {
    // "auto" 仍只作为旧配置兼容输入回退厂商默认；responses 必须原样透传
    expect(
      resolveTransport({
        baseUrl: "https://api.openai.com/v1",
        explicitTransport: "responses",
        provider: "ChatGPT（OpenAI）",
      }),
    ).toBe("responses");
  });
});
