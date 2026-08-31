import { describe, expect, it, vi } from "vitest";
import {
  createEndpointPinnedFetch,
  deriveAnthropicClientConfig,
  deriveOpenAIClientConfig,
} from "./client-config";

describe("SDK client configuration", () => {
  it.each([
    ["https://host.test/v1/chat/completions", "https://host.test/v1"],
    ["https://host.test/proxy/openai/chat/completions", "https://host.test/proxy/openai"],
  ])("derives the OpenAI base URL from %s", (endpoint, expected) => {
    expect(deriveOpenAIClientConfig(endpoint, "sk-openai")).toEqual({
      baseURL: expected,
      apiKey: "sk-openai",
      maxRetries: 0,
    });
  });

  it("derives a standard Anthropic base URL and x-api-key auth", () => {
    expect(
      deriveAnthropicClientConfig("https://host.test/proxy/v1/messages", "sk-anthropic", "x-api-key"),
    ).toEqual({
      baseURL: "https://host.test/proxy",
      apiKey: "sk-anthropic",
      maxRetries: 0,
    });
  });

  it("maps bearer-compatible Anthropic endpoints to authToken", () => {
    expect(
      deriveAnthropicClientConfig("https://host.test/v1/messages", "token", "bearer"),
    ).toEqual({
      baseURL: "https://host.test",
      authToken: "token",
      maxRetries: 0,
    });
  });

  it("pins a nonstandard full Anthropic messages endpoint without changing request semantics", async () => {
    const controller = new AbortController();
    const delegate = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const pinned = createEndpointPinnedFetch("https://host.test/custom/messages", delegate);
    const original = new Request("https://host.test/v1/messages", {
      method: "POST",
      headers: { "x-test": "kept" },
      body: "payload",
      signal: controller.signal,
    });

    await pinned(original);

    expect(delegate).toHaveBeenCalledOnce();
    const forwarded = delegate.mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(Request);
    const request = forwarded as Request;
    expect(request.url).toBe("https://host.test/custom/messages");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-test")).toBe("kept");
    expect(await request.text()).toBe("payload");
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("attaches the URL-only fetch wrapper only for nonstandard Anthropic paths", () => {
    const delegate = vi.fn<typeof fetch>();
    const standard = deriveAnthropicClientConfig(
      "https://host.test/v1/messages",
      "sk",
      "x-api-key",
      delegate,
    );
    const custom = deriveAnthropicClientConfig(
      "https://host.test/custom/messages",
      "sk",
      "x-api-key",
      delegate,
    );

    expect(standard.fetch).toBeUndefined();
    expect(custom.baseURL).toBe("https://host.test");
    expect(custom.fetch).toBeTypeOf("function");
  });
});
