// reasoning 透传到真实 adapter buildRequest 的契约测试（用户第三轮修订 #5）。
//
// 原则：
//   - 不做字符串扫描（不 grep "reasoning" src/main/index.ts）
//   - 不抽 buildVendorConfig helper
//   - 不 mock main/index
//   - 改走真实 adapter 调用路径：构造符合 VendorConfig 形状的 fake cfg，
//     调 adapter.buildRequest，断言 JSON body

import { describe, expect, test } from "vitest";
import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import type { ProviderCapability, VendorConfig } from "./types";
import type { ReasoningPreference } from "../../../shared/reasoning";

const chatgptCap: ProviderCapability = {
  id: "chatgpt",
  displayName: "ChatGPT（OpenAI）",
  transport: "openai",
  baseUrl: "https://api.openai.com/v1",
  authStyle: "bearer",
  defaultModel: "gpt-5.6",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "reasoning_content",
  cacheStrategy: "auto",
  testStrategy: "text",
  supportsVision: false,
};

const claudeCap: ProviderCapability = {
  id: "claude",
  displayName: "Claude（Anthropic）",
  transport: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  authStyle: "x-api-key",
  defaultModel: "claude-sonnet-5",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "thinking",
  cacheStrategy: "cache_control",
  testStrategy: "text",
  supportsVision: true,
  disabled: true,
};

const mimoCap: ProviderCapability = {
  id: "mimo",
  displayName: "MiMo（小米）",
  transport: "openai",
  baseUrl: "https://api.xiaomimimo.com/v1",
  authStyle: "bearer",
  defaultModel: "mimo-v2.5-pro",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "reasoning_content",
  cacheStrategy: "auto",
  testStrategy: "text",
  supportsVision: true,
  visionBaseUrl: "https://api.xiaomimimo.com/v1",
};

function cfgOf(
  cap: ProviderCapability,
  overrides: Partial<VendorConfig> & { model?: string; reasoning?: ReasoningPreference },
): VendorConfig {
  return {
    provider: cap.displayName,
    baseUrl: cap.baseUrl,
    model: overrides.model ?? cap.defaultModel,
    apiKey: "sk-test",
    ...(overrides.reasoning ? { reasoning: overrides.reasoning } : {}),
  };
}

describe("G1 OpenAI chatgpt + reasoning 透传", () => {
  const adapter = new OpenAICompatAdapter("chatgpt", chatgptCap);

  test("gpt-5.6 + {mode:'on', effort:'high'} → body.reasoning_effort === 'high'", () => {
    const http = adapter.buildRequest(
      { model: "gpt-5.6", messages: [{ role: "user", content: "hi" }] },
      cfgOf(chatgptCap, { model: "gpt-5.6", reasoning: { mode: "on", effort: "high" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
  });

  test("gpt-5.6 + reasoning=auto → body 中无 reasoning_effort", () => {
    const http = adapter.buildRequest(
      { model: "gpt-5.6", messages: [{ role: "user", content: "hi" }] },
      cfgOf(chatgptCap, { model: "gpt-5.6", reasoning: { mode: "auto" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect("reasoning_effort" in body).toBe(false);
  });

  test("gpt-4o + reasoning=auto → body 中无 reasoning_effort（非推理模型）", () => {
    const http = adapter.buildRequest(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      cfgOf(chatgptCap, { model: "gpt-4o", reasoning: { mode: "auto" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect("reasoning_effort" in body).toBe(false);
  });
});

describe("G2 Claude + reasoning 透传", () => {
  const adapter = new AnthropicAdapter("claude", claudeCap);

  test("claude-sonnet-5 + {mode:'on', effort:'xhigh'} → body.output_config.effort === 'xhigh' 且 thinking.type === 'adaptive'", () => {
    const http = adapter.buildRequest(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      cfgOf(claudeCap, { model: "claude-sonnet-5", reasoning: { mode: "on", effort: "xhigh" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect((body.output_config as Record<string, unknown>).effort).toBe("xhigh");
    expect((body.thinking as Record<string, unknown>).type).toBe("adaptive");
  });
});

describe("G3 reasoning=undefined（视为 auto）", () => {
  test("mimo mimo-v2.5-pro + reasoning=undefined → body 中无 thinking", () => {
    const adapter = new OpenAICompatAdapter("mimo", mimoCap);
    const cfg: VendorConfig = {
      provider: mimoCap.displayName,
      baseUrl: mimoCap.baseUrl,
      model: "mimo-v2.5-pro",
      apiKey: "sk-test",
      // reasoning 缺省
    };
    const http = adapter.buildRequest(
      { model: "mimo-v2.5-pro", messages: [{ role: "user", content: "hi" }] },
      cfg,
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect("thinking" in body).toBe(false);
    expect("enable_thinking" in body).toBe(false);
  });
});

describe("G4 cfg.reasoning 改动 → JSON body 改动（契约：adapter 必须读 cfg.reasoning）", () => {
  test("MiniMax-M3 auto vs off → body.thinking.type 不同", () => {
    const miniMaxCap: ProviderCapability = {
      id: "minimax",
      displayName: "MiniMax（稀宇科技）",
      transport: "anthropic",
      baseUrl: "https://api.minimaxi.com/anthropic",
      authStyle: "x-api-key",
      defaultModel: "MiniMax-M3",
      supportsTools: true,
      supportsThinking: true,
      thinkingField: "thinking",
      cacheStrategy: "cache_control",
      testStrategy: "text",
      supportsVision: true,
      visionBaseUrl: "https://api.minimaxi.com/v1",
    };
    const adapter = new AnthropicAdapter("minimax", miniMaxCap);

    const baseReq = { model: "MiniMax-M3", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

    const httpAuto = adapter.buildRequest(baseReq, {
      ...cfgOf(miniMaxCap, { model: "MiniMax-M3", reasoning: { mode: "auto" } }),
    });
    const httpOn = adapter.buildRequest(baseReq, {
      ...cfgOf(miniMaxCap, { model: "MiniMax-M3", reasoning: { mode: "on" } }),
    });
    const httpOff = adapter.buildRequest(baseReq, {
      ...cfgOf(miniMaxCap, { model: "MiniMax-M3", reasoning: { mode: "off" } }),
    });

    const bodyAuto = JSON.parse(httpAuto.body) as Record<string, unknown>;
    const bodyOn = JSON.parse(httpOn.body) as Record<string, unknown>;
    const bodyOff = JSON.parse(httpOff.body) as Record<string, unknown>;

    // auto 不发 thinking
    expect("thinking" in bodyAuto).toBe(false);
    // on 发 adaptive
    expect((bodyOn.thinking as Record<string, unknown>).type).toBe("adaptive");
    // off 发 disabled
    expect((bodyOff.thinking as Record<string, unknown>).type).toBe("disabled");
  });

  test("DeepSeek v4 toggle + on vs off → body.thinking.type 不同", () => {
    const dsCap: ProviderCapability = {
      id: "deepseek",
      displayName: "DeepSeek（深度求索）",
      transport: "openai",
      baseUrl: "https://api.deepseek.com",
      authStyle: "bearer",
      defaultModel: "deepseek-v4-pro",
      supportsTools: true,
      supportsThinking: true,
      thinkingField: "reasoning_content",
      cacheStrategy: "auto",
      testStrategy: "text",
      supportsVision: false,
    };
    const adapter = new OpenAICompatAdapter("deepseek", dsCap);

    const baseReq = { model: "deepseek-v4-pro", messages: [{ role: "user" as const, content: "hi" }] };

    const httpOn = adapter.buildRequest(baseReq, {
      ...cfgOf(dsCap, { model: "deepseek-v4-pro", reasoning: { mode: "on", effort: "max" } }),
    });
    const httpOff = adapter.buildRequest(baseReq, {
      ...cfgOf(dsCap, { model: "deepseek-v4-pro", reasoning: { mode: "off" } }),
    });
    const bodyOn = JSON.parse(httpOn.body) as Record<string, unknown>;
    const bodyOff = JSON.parse(httpOff.body) as Record<string, unknown>;

    expect((bodyOn.thinking as Record<string, unknown>).type).toBe("enabled");
    expect(bodyOn.reasoning_effort).toBe("max");
    expect((bodyOff.thinking as Record<string, unknown>).type).toBe("disabled");
  });
});

describe("G5 5+ 关键 capability 形态端到端", () => {
  test("Kimi K2.7-Code + {mode:'on'} → body 中无 thinking（fixed-on + requestStyle=none）", () => {
    const kimiCap: ProviderCapability = {
      id: "kimi",
      displayName: "Kimi（月之暗面）",
      transport: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      authStyle: "bearer",
      defaultModel: "kimi-k2.7-code",
      supportsTools: true,
      supportsThinking: true,
      thinkingField: "thinking",
      cacheStrategy: "prompt_cache_key",
      testStrategy: "text",
      supportsVision: true,
    };
    const adapter = new OpenAICompatAdapter("kimi", kimiCap);
    const http = adapter.buildRequest(
      { model: "kimi-k2.7-code", messages: [{ role: "user", content: "hi" }] },
      cfgOf(kimiCap, { model: "kimi-k2.7-code", reasoning: { mode: "on" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect("thinking" in body).toBe(false);
  });

  test("Kimi K2.6 + {mode:'on', hasTools} → body.thinking.keep === 'all'", () => {
    const kimiCap: ProviderCapability = {
      id: "kimi",
      displayName: "Kimi（月之暗面）",
      transport: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      authStyle: "bearer",
      defaultModel: "kimi-k2.6",
      supportsTools: true,
      supportsThinking: true,
      thinkingField: "thinking",
      cacheStrategy: "prompt_cache_key",
      testStrategy: "text",
      supportsVision: true,
    };
    const adapter = new OpenAICompatAdapter("kimi", kimiCap);
    const http = adapter.buildRequest(
      {
        model: "kimi-k2.6",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "tool", description: "d", parameters: { type: "object" } }],
      },
      cfgOf(kimiCap, { model: "kimi-k2.6", reasoning: { mode: "on" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  test("Qwen qwen3-max + {mode:'on'} → body.enable_thinking === true 且 body 中无 thinking", () => {
    const qwenCap: ProviderCapability = {
      id: "qwen",
      displayName: "Qwen（通义千问）",
      transport: "openai",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      authStyle: "bearer",
      defaultModel: "qwen-max",
      supportsTools: true,
      supportsThinking: true,
      thinkingField: "reasoning_content",
      cacheStrategy: "auto",
      testStrategy: "text",
      supportsVision: false,
    };
    const adapter = new OpenAICompatAdapter("qwen", qwenCap);
    const http = adapter.buildRequest(
      { model: "qwen3-max", messages: [{ role: "user", content: "hi" }] },
      cfgOf(qwenCap, { model: "qwen3-max", reasoning: { mode: "on" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect(body.enable_thinking).toBe(true);
    expect("thinking" in body).toBe(false);
  });

  test("豆包 seed 2.1 + {mode:'on'} → body.thinking.type=enabled", () => {
    const doubaoCap: ProviderCapability = {
      id: "doubao",
      displayName: "豆包（火山方舟）",
      transport: "openai",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      authStyle: "bearer",
      defaultModel: "doubao-seed-2-1-pro-260628",
      supportsTools: true,
      supportsThinking: true,
      thinkingField: "reasoning_content",
      cacheStrategy: "none",
      testStrategy: "text",
      supportsVision: true,
    };
    const adapter = new OpenAICompatAdapter("doubao", doubaoCap);
    const http = adapter.buildRequest(
      { model: "doubao-seed-2-1-pro-260628", messages: [{ role: "user", content: "hi" }] },
      cfgOf(doubaoCap, { model: "doubao-seed-2-1-pro-260628", reasoning: { mode: "on" } }),
    );
    const body = JSON.parse(http.body) as Record<string, unknown>;
    expect("reasoning_effort" in body).toBe(false);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect("enable_thinking" in body).toBe(false);
  });
});
