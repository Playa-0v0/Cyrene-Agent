import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => mocks.available,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^sealed:/, ""),
  },
}));

import { preserveCurrentSecrets, protectSecrets, redactSecrets, revealSecrets } from "./secret-vault";

describe("secret vault", () => {
  beforeEach(() => { mocks.available = true; });

  it("protects nested provider and service credentials and can reveal them", () => {
    const settings = {
      apiKey: "main-secret",
      searchTavilyKey: "search-secret",
      emailSmtpPass: "mail-secret",
      perProvider: { custom: { apiKey: "nested-secret", model: "demo" } },
    };
    const protectedValue = protectSecrets(settings);
    expect(protectedValue.apiKey).toMatch(/^cyvault:v1:/);
    expect(protectedValue.searchTavilyKey).toMatch(/^cyvault:v1:/);
    expect(protectedValue.perProvider.custom.apiKey).toMatch(/^cyvault:v1:/);
    expect(protectedValue.perProvider.custom.model).toBe("demo");
    expect(revealSecrets(protectedValue)).toEqual(settings);
  });

  it("leaves plaintext untouched when the OS vault is unavailable", () => {
    mocks.available = false;
    expect(protectSecrets({ apiKey: "secret" })).toEqual({ apiKey: "secret" });
  });

  it("redacts backup secrets and preserves current encrypted values on restore", () => {
    const current = protectSecrets({ apiKey: "keep-me", model: "new-model" });
    const incoming = redactSecrets({ apiKey: "old-secret", model: "old-model" });
    expect(preserveCurrentSecrets(incoming, current)).toEqual({ apiKey: current.apiKey, model: "old-model" });
  });
});
