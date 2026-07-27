import { describe, it, expect } from "vitest";
import { detectTransport, resolveTransport } from "./transport-detector";

describe("detectTransport", () => {
  it("路徑含 /anthropic 走 anthropic", () => {
    expect(detectTransport("https://api.minimaxi.com/anthropic")).toBe("anthropic");
  });

  it("trailing slash 容錯", () => {
    expect(detectTransport("https://api.minimaxi.com/anthropic/")).toBe("anthropic");
  });

  it("/anthropic 後面跟其他路徑仍判 anthropic", () => {
    expect(detectTransport("https://example.com/anthropic/v1/something")).toBe("anthropic");
  });

  it("路徑含 /v1/messages 走 anthropic（無 query）", () => {
    expect(detectTransport("https://api.example.com/v1/messages")).toBe("anthropic");
  });

  it("路徑含 /v1/messages 帶 query 仍判 anthropic", () => {
    expect(detectTransport("https://api.example.com/v1/messages?beta=true")).toBe("anthropic");
  });

  it("路徑僅以 /v1 結尾 → openai 啟發式", () => {
    expect(detectTransport("https://api.minimaxi.com/v1")).toBe("openai");
  });

  it("路徑含 /chat/completions 走 openai", () => {
    expect(detectTransport("https://api.deepseek.com/chat/completions")).toBe("openai");
  });

  it("路徑僅 /completions 走 openai", () => {
    expect(detectTransport("https://api.example.com/completions")).toBe("openai");
  });

  it("空字符串 → null（無法判斷）", () => {
    expect(detectTransport("")).toBe(null);
  });

  it("純域名無路徑 → null（capability fallback）", () => {
    expect(detectTransport("https://api.deepseek.com")).toBe(null);
  });

  it("全大寫 URL 也工作（lowercase 容錯）", () => {
    expect(detectTransport("HTTPS://API.MINIMAXI.COM/ANTHROPIC")).toBe("anthropic");
  });
});

describe("resolveTransport（三層優先級）", () => {
  it("用戶顯式 anthropic 優先於 baseUrl", () => {
    // baseUrl 是 /v1（啟發式為 openai），但 explicitTransport="anthropic" 必須勝出
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/v1",
        explicitTransport: "anthropic",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("anthropic");
  });

  it("用戶顯式 openai 優先於 baseUrl", () => {
    // baseUrl 是 /anthropic（啟發式為 anthropic），但 explicitTransport="openai" 必須勝出
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/anthropic",
        explicitTransport: "openai",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("openai");
  });

  it("explicitTransport=auto → 走 detectTransport", () => {
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/v1",
        explicitTransport: "auto",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("openai");
  });

  it("explicitTransport=undefined → 走 detectTransport → fallback capabilities", () => {
    // DeepSeek baseUrl 無路徑線索 → null → capabilities 表 fallback（DeepSeek 是 openai）
    expect(
      resolveTransport({
        baseUrl: "https://api.deepseek.com",
        provider: "DeepSeek（深度求索）",
      }),
    ).toBe("openai");
  });

  it("explicitTransport=undefined + baseUrl 啟發式命中 → 用啟發式（覆蓋 capabilities）", () => {
    // MiniMax capabilities 默認 anthropic，但 baseUrl /v1 啟發式 openai → openai 勝出
    expect(
      resolveTransport({
        baseUrl: "https://api.minimaxi.com/v1",
        provider: "MiniMax（稀宇科技）",
      }),
    ).toBe("openai");
  });
});