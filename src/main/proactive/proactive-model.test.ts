import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildRequest: vi.fn(),
  parseResponse: vi.fn(),
  recordUsage: vi.fn(),
  recordRequest: vi.fn(),
}));

vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: mocks.buildRequest,
    parseResponse: mocks.parseResponse,
  }),
}));

vi.mock("../token-usage-store", () => ({ recordUsage: mocks.recordUsage, recordRequest: mocks.recordRequest }));

import { runProactiveModel } from "./proactive-model";

describe("runProactiveModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildRequest.mockImplementation((request: unknown) => ({
      url: "https://example.test/chat",
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: JSON.stringify(request),
    }));
  });

  it("builds one non-streaming request with no tool capability", async () => {
    mocks.parseResponse.mockReturnValue({
      text: '{"decision":"send","text":"休息一下吧♪"}',
      usage: { input: 12, output: 8 },
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await runProactiveModel({
      settings: { provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key" },
      messages: [
        { role: "system", content: "persona + proactive system" },
        { role: "user", content: "return json" },
      ],
      timeoutMs: 1_000,
      fetchFn,
    });

    const request = mocks.buildRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(request.stream).toBe(false);
    expect(request).not.toHaveProperty("tools");
    expect(JSON.stringify(request)).not.toContain("tool_calls");
    expect(result).toEqual({ kind: "send", text: "休息一下吧♪" });
    expect(mocks.recordUsage).toHaveBeenCalledWith(12, 8, 1, undefined, "model", undefined);
  });

  it("returns silent only after parsing the complete response", async () => {
    mocks.parseResponse.mockReturnValue({ text: '{"decision":"silent","text":""}' });
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(runProactiveModel({
      settings: { provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key" },
      messages: [{ role: "system", content: "system" }],
      timeoutMs: 1_000,
      fetchFn,
    })).resolves.toEqual({ kind: "silent" });
  });

  it("classifies invalid output and HTTP failures for safe fallback", async () => {
    mocks.parseResponse.mockReturnValue({ text: "not-json" });
    await expect(runProactiveModel({
      settings: { provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key" },
      messages: [{ role: "system", content: "system" }],
      timeoutMs: 1_000,
      fetchFn: vi.fn(async () => new Response("{}", { status: 200 })),
    })).resolves.toEqual({ kind: "invalid", reason: "invalid_json" });

    await expect(runProactiveModel({
      settings: { provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key" },
      messages: [{ role: "system", content: "system" }],
      timeoutMs: 1_000,
      fetchFn: vi.fn(async () => new Response("bad", { status: 503 })),
    })).resolves.toEqual({ kind: "error", reason: "http_503" });
  });

  it("rejects tool-role or tool-call messages before network access", async () => {
    const fetchFn = vi.fn();
    const result = await runProactiveModel({
      settings: { provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key" },
      messages: [{ role: "tool", content: "forbidden", toolCallId: "1" }],
      timeoutMs: 1_000,
      fetchFn,
    });
    expect(result).toEqual({ kind: "error", reason: "tool_content_forbidden" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
