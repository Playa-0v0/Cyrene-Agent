import { describe, expect, test, vi } from "vitest";
import type { ChatVendorAdapter, VendorConfig } from "./types";
import { testVendorConnection } from "./test-connection";

describe("testVendorConnection", () => {
  test("uses the runtime config without dropping transport or reasoning", async () => {
    const cfg: VendorConfig = {
      provider: "MiniMax（稀宇科技）",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      apiKey: "secret",
      explicitTransport: "openai",
      reasoning: { mode: "off" },
    };
    const testConnection = vi.fn().mockResolvedValue({ ok: true, latency: 1 });
    const resolveAdapter = vi.fn().mockReturnValue({
      transport: "openai",
      testConnection,
    } as unknown as ChatVendorAdapter);

    await testVendorConnection(cfg, resolveAdapter);

    expect(resolveAdapter).toHaveBeenCalledWith(cfg);
    expect(testConnection).toHaveBeenCalledWith(cfg);
  });
});
