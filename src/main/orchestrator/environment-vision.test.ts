import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { modelSupportsVision } from "./environment";

describe("模型視覺能力判斷", () => {
  it("把 Custom profile 下的 OpenRouter Free 視為支援視覺路由", () => {
    expect(modelSupportsVision({
      provider: "Custom",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
    })).toBe(true);
  });

  it("未知純文字自訂端點維持保守判斷", () => {
    expect(modelSupportsVision({ provider: "Custom", baseUrl: "https://example.com/v1", model: "text-only" })).toBe(false);
  });
});
