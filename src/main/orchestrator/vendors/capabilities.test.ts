import { describe, expect, test } from "vitest";
import { PROVIDER_CAPABILITIES, getCapability } from "./capabilities";
import { getAdapterForConfig } from "./index";

describe("PROVIDER_CAPABILITIES — schema smoke", () => {
  test("每条 capability 都有 id 与 displayName，且非空", () => {
    for (const cap of PROVIDER_CAPABILITIES) {
      expect(cap.id, `entry missing id`).toBeTruthy();
      expect(cap.displayName, `entry ${cap.id} missing displayName`).toBeTruthy();
    }
  });

  test("id 唯一（不允许两条 capability 共享同一 id）", () => {
    const ids = PROVIDER_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("displayName 唯一（不允许两条 capability 共享同一显示名）", () => {
    const names = PROVIDER_CAPABILITIES.map((c) => c.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("MiMo（小米）条目存在且关键字段齐全", () => {
    const mimo = getCapability("MiMo（小米）");
    expect(mimo).toBeDefined();
    expect(mimo?.id).toBe("mimo");
    expect(mimo?.displayName).toBe("MiMo（小米）");
  });

  test("豆包替换火山 AgentPlan，使用官方方舟 Chat Completions 入口", () => {
    expect(getCapability("豆包（火山方舟）")).toMatchObject({
      id: "doubao",
      transport: "openai",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-seed-2-1-pro-260628",
    });
    expect(getCapability("火山 AgentPlan（火山引擎）")).toBeUndefined();
    expect(PROVIDER_CAPABILITIES.some((capability) => capability.id === "volcengine")).toBe(false);
  });
});

describe("PROVIDER_CAPABILITIES — 已知条目存在性回归", () => {
  test("MiniMax 默认使用 OpenAI 兼容入口", () => {
    expect(getCapability("MiniMax（稀宇科技）")).toMatchObject({
      transport: "openai",
      baseUrl: "https://api.minimaxi.com/v1",
      authStyle: "bearer",
    });
  });

  test("MiniMax 默认配置生成 OpenAI chat/completions 与 Bearer 请求", () => {
    const cfg = {
      provider: "MiniMax（稀宇科技）",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      apiKey: "test-key",
      explicitTransport: "auto" as const,
    };
    const adapter = getAdapterForConfig(cfg);
    const request = adapter.buildRequest(
      { model: cfg.model, messages: [{ role: "user", content: "ping" }] },
      cfg,
    );

    expect(adapter.transport).toBe("openai");
    expect(request.url).toBe("https://api.minimaxi.com/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(request.headers["x-api-key"]).toBeUndefined();
  });

  test("9 家 provider 的 displayName 都在表中", () => {
    const names = new Set(PROVIDER_CAPABILITIES.map((c) => c.displayName));
    for (const expected of [
      "MiniMax（稀宇科技）",
      "DeepSeek（深度求索）",
      "豆包（火山方舟）",
      "GLM（智谱）",
      "Kimi（月之暗面）",
      "Qwen（通义千问）",
      "ChatGPT（OpenAI）",
      "Claude（Anthropic）",
      "MiMo（小米）",
    ]) {
      expect(names.has(expected), `missing displayName: ${expected}`).toBe(true);
    }
  });
});
