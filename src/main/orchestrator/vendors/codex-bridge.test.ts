import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexBridge, type CodexBridgeHandle } from "./codex-bridge";
import type { CodexOAuthAuth } from "./codex-oauth-auth";
import { OpenAICompatAdapter } from "./openai-adapter";
import { getCapability } from "./capabilities";

function fakeAuth(overrides: Partial<{
  loggedIn: boolean;
  accessToken: string;
  accountId: string;
  getValidAccessTokenImpl: () => Promise<{ accessToken: string; accountId: string }>;
}> = {}): CodexOAuthAuth {
  const loggedIn = overrides.loggedIn ?? true;
  const accessToken = overrides.accessToken ?? "test-access-token";
  const accountId = overrides.accountId ?? "acct_test";
  return {
    getStatus: vi.fn().mockResolvedValue(loggedIn ? { loggedIn: true, accountId } : { loggedIn: false }),
    getValidAccessToken:
      overrides.getValidAccessTokenImpl ?? vi.fn().mockResolvedValue({ accessToken, accountId }),
    forceRefresh: vi.fn().mockResolvedValue({ accessToken, accountId }),
  } as unknown as CodexOAuthAuth;
}

function sseCompletedResponse(text: string, usage: { input_tokens: number; output_tokens: number }): Response {
  const payload = {
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text }] }],
      usage,
    },
  };
  const body = `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * 真实抓到的 gpt-5.6-sol 响应形状（2026-07 实测）：终结事件的 output 是**空数组**，
 * 正文只出现在中途的 output_text.delta 和 output_item.done 里。
 * 之前的实现只读终结事件的 output，于是拿到空字符串、误报 502。
 */
function sseRealWorldShape(text: string, usage: { input_tokens: number; output_tokens: number }): Response {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body =
    ev("response.created", { type: "response.created", response: { status: "in_progress" } }) +
    ev("response.output_item.added", {
      type: "response.output_item.added",
      item: { id: "msg_1", type: "message", content: [] },
    }) +
    ev("response.output_text.delta", { type: "response.output_text.delta", delta: text }) +
    ev("response.output_item.done", {
      type: "response.output_item.done",
      item: { id: "msg_1", type: "message", content: [{ type: "output_text", text }] },
    }) +
    // 注意这里 output: [] —— 这就是真实响应，不是造出来的极端情况
    ev("response.completed", {
      type: "response.completed",
      response: { status: "completed", output: [], usage },
    });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function postChatCompletions(
  bridge: CodexBridgeHandle,
  body: unknown,
  token = bridge.token,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

describe("codex-bridge", () => {
  let bridge: CodexBridgeHandle | undefined;

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = undefined;
    }
  });

  /** 不该被打到上游的用例（400/401 那些）统一用这个：被调用就是 bug。 */
  const noUpstream = (): never => {
    throw new Error("这个用例不应该发起上游 Codex 请求");
  };

  it("401 当 bridge token 不对", async () => {
    bridge = await startCodexBridge(fakeAuth(), noUpstream);
    const { status, json } = await postChatCompletions(
      bridge,
      { model: "gpt-5.1-codex", messages: [{ role: "user", content: "hi" }] },
      "wrong-token",
    );
    expect(status).toBe(401);
    expect(json.error.message).toMatch(/token 不匹配/);
  });

  it("400 当请求带 tools（Work 模式硬拦）", async () => {
    bridge = await startCodexBridge(fakeAuth(), noUpstream);
    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "foo", description: "", parameters: {} } }],
    });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/只支持 Chat 模式/);
  });

  it("400 当请求带 tool_choice", async () => {
    bridge = await startCodexBridge(fakeAuth(), noUpstream);
    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
    });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/tool_choice/);
  });

  it("400 当请求 stream: true", async () => {
    bridge = await startCodexBridge(fakeAuth(), noUpstream);
    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/流式/);
  });

  it("401 当未登录", async () => {
    bridge = await startCodexBridge(fakeAuth({ loggedIn: false }), noUpstream);
    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(401);
    expect(json.error.message).toMatch(/登录 ChatGPT/);
  });

  it("happy path：响应能被真实 OpenAICompatAdapter.parseResponse 解析", async () => {
    const codexFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(init!.body as string);
      // Codex 后端只说 SSE，且不该留存对话
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      // system 消息应该合进 instructions，而不是塞进 input
      expect(body.instructions).toBe("你是一个助手");
      expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "你好" }] }]);
      expect(init!.headers).toMatchObject({
        Authorization: "Bearer test-access-token",
        "chatgpt-account-id": "acct_test",
      });
      return sseCompletedResponse("你好，我是 Codex。", { input_tokens: 12, output_tokens: 8 });
    });
    bridge = await startCodexBridge(fakeAuth(), codexFetch);

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [
        { role: "system", content: "你是一个助手" },
        { role: "user", content: "你好" },
      ],
    });
    expect(status).toBe(200);

    const capability = getCapability("ChatGPT / Codex（订阅）")!;
    const adapter = new OpenAICompatAdapter("codex", capability);
    const parsed = adapter.parseResponse(json);
    expect(parsed.text).toBe("你好，我是 Codex。");
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.usage).toEqual({ input: 12, output: 8 });
  });

  // 回归：终结事件 output 为空、正文只在 delta / output_item.done 里。
  // 这就是线上真实响应的样子，之前的实现在这里返回 502「没有返回任何文本」。
  it("终结事件 output 为空时，仍能从 delta / output_item 拿到正文", async () => {
    bridge = await startCodexBridge(
      fakeAuth(),
      vi.fn(async () => sseRealWorldShape("ok", { input_tokens: 8, output_tokens: 5 })),
    );

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "say ok" }],
    });

    expect(status).toBe(200);
    expect(json.choices[0].message.content).toBe("ok");
    expect(json.usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 5 });
  });

  it("只有 delta、连 output_item 都没有时也能拿到正文", async () => {
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    bridge = await startCodexBridge(
      fakeAuth(),
      vi.fn(
        async () =>
          new Response(
            ev("response.output_text.delta", { type: "response.output_text.delta", delta: "分两段" }) +
              ev("response.output_text.delta", { type: "response.output_text.delta", delta: "拼起来" }) +
              ev("response.completed", {
                type: "response.completed",
                response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2 } },
              }),
            { status: 200 },
          ),
      ),
    );

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(200);
    expect(json.choices[0].message.content).toBe("分两段拼起来");
  });

  it("确实没有正文时，502 文案要报出可核对的事实而不是猜原因", async () => {
    bridge = await startCodexBridge(
      fakeAuth(),
      vi.fn(
        async () =>
          new Response(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: { status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } },
            })}\n\n`,
            { status: 200 },
          ),
      ),
    );

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(502);
    // 必须带上 status / usage 这些能直接核对的事实
    expect(json.error.message).toMatch(/status=completed/);
    expect(json.error.message).toMatch(/usage=0\/0/);
    // 不许再出现"订阅额度用尽"这种没依据的猜测
    expect(json.error.message).not.toMatch(/额度用尽/);
  });

  // 上游在 SSE 里回 error 事件时，必须把它的原话透出来。
  // 这条是踩坑后补的：早先实现把 error 内容收进变量却从不使用，真实原因被
  // 自造的"没有返回任何文本"盖掉，排查被带偏了两轮。
  it("上游 error 事件的原文必须出现在返回的错误里", async () => {
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    bridge = await startCodexBridge(
      fakeAuth(),
      vi.fn(
        async () =>
          new Response(
            ev("response.created", { type: "response.created", response: { status: "in_progress" } }) +
              ev("error", { type: "error", error: { message: "Something specific went wrong upstream." } }) +
              ev("response.failed", { type: "response.failed", response: { status: "failed" } }),
            { status: 200 },
          ),
      ),
    );

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(502);
    expect(json.error.message).toMatch(/Something specific went wrong upstream/);
    // 绝不能再退化成那句自造的话
    expect(json.error.message).not.toMatch(/没有返回任何文本/);
  });

  it("上游临时过载会自动重试，重试成功就正常返回", async () => {
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    let calls = 0;
    const codexFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          ev("response.created", { type: "response.created", response: { status: "in_progress" } }) +
            ev("error", {
              type: "error",
              error: { message: "Our servers are currently overloaded. Please try again later." },
            }),
          { status: 200 },
        );
      }
      return sseRealWorldShape("ok", { input_tokens: 8, output_tokens: 5 });
    });
    bridge = await startCodexBridge(fakeAuth(), codexFetch);

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(200);
    expect(calls).toBe(2);
    expect(json.choices[0].message.content).toBe("ok");
  });

  it("持续过载时给出「这是上游容量问题」的定性，别让人去查配置", async () => {
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    let calls = 0;
    const codexFetch = vi.fn(async () => {
      calls++;
      return new Response(
        ev("response.created", { type: "response.created", response: { status: "in_progress" } }) +
          ev("error", {
            type: "error",
            error: { message: "Our servers are currently overloaded. Please try again later." },
          }),
        { status: 200 },
      );
    });
    bridge = await startCodexBridge(fakeAuth(), codexFetch);

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(502);
    expect(calls).toBe(3); // 首次 + 两次退避重试
    expect(json.error.message).toMatch(/overloaded/i);
    expect(json.error.message).toMatch(/临时容量问题/);
  });

  it("非临时错误（比如模型不支持）不重试，直接报出来", async () => {
    let calls = 0;
    const codexFetch = vi.fn(async () => {
      calls++;
      return new Response(
        JSON.stringify({ detail: "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account." }),
        { status: 400 },
      );
    });
    bridge = await startCodexBridge(fakeAuth(), codexFetch);

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(502);
    expect(calls).toBe(1); // 不该浪费时间重试
    expect(json.error.message).toMatch(/not supported when using Codex/);
  });

  it("上游 401 时强制刷新一次并重试", async () => {
    let calls = 0;
    const auth = fakeAuth({
      getValidAccessTokenImpl: vi.fn().mockResolvedValue({ accessToken: "stale", accountId: "acct_test" }),
    });
    const codexFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const headers = init!.headers as Record<string, string>;
      if (headers.Authorization === "Bearer stale") {
        return new Response("", { status: 401 });
      }
      return sseCompletedResponse("刷新后成功", { input_tokens: 1, output_tokens: 1 });
    });
    bridge = await startCodexBridge(auth, codexFetch);

    const { status, json } = await postChatCompletions(bridge, {
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(200);
    expect(calls).toBe(2);
    expect(json.choices[0].message.content).toBe("刷新后成功");
    expect(auth.forceRefresh).toHaveBeenCalledOnce();
  });

  it("404 给非 /v1/chat/completions 路径", async () => {
    bridge = await startCodexBridge(fakeAuth(), noUpstream);
    const res = await fetch(`${bridge.baseUrl.replace(/\/v1$/, "")}/v1/models`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}` },
    });
    expect(res.status).toBe(404);
  });
});
