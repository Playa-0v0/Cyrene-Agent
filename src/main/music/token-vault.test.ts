import { describe, it, expect, beforeEach, vi } from "vitest";
import { TokenVault } from "./token-vault";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString("utf8").replace(/^enc:/, "")),
  },
}));

const safeStorageMock = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: vi.fn((b: Buffer) => b.toString("utf8").replace(/^enc:/, "")),
};

const BUNDLE = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expireTime: 86_400,
  gotAt: 1_700_000_000_000,
};

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "token-vault-"));
});

describe("TokenVault", () => {
  it("persists and reads back a bundle atomically", async () => {
    const v = new TokenVault(dir, safeStorageMock as never);
    expect(await v.persist(BUNDLE)).toBe(true);
    const blob = await v.load();
    expect(blob?.formatVersion).toBe(1);
    expect(blob?.provider).toBe("netease-openapi");
    const restored = await v.decrypt(blob!);
    expect(restored).toEqual(BUNDLE);
  });

  it("returns null when no token file exists", async () => {
    const v = new TokenVault(dir, safeStorageMock as never);
    expect(await v.load()).toBeNull();
  });

  it("rejects unsupported formatVersion / provider", async () => {
    await fs.writeFile(path.join(dir, "token.enc"), JSON.stringify({ formatVersion: 99, provider: "x" }));
    const v = new TokenVault(dir, safeStorageMock as never);
    await expect(v.load()).rejects.toThrow(/E_TOKEN_BLOB_UNREADABLE/);
  });

  it("rejects decrypted payload missing accessToken", async () => {
    const v = new TokenVault(dir, safeStorageMock as never);
    const blob = { formatVersion: 1 as const, provider: "netease-openapi" as const, savedAt: 1, payload: Buffer.from("enc:" + JSON.stringify({ refreshToken: "r" })) };
    await expect(v.decrypt(blob)).rejects.toThrow(/E_TOKEN_BLOB_UNREADABLE/);
  });

  it("falls back to plaintext when safeStorage is unavailable", async () => {
    const noSafe = { ...safeStorageMock, isEncryptionAvailable: () => false };
    const v = new TokenVault(dir, noSafe as never);
    expect(await v.persist(BUNDLE)).toBe(true);
    // 能读回且解密成功（明文 fallback 路径）
    const blob = await v.load();
    expect(blob).not.toBeNull();
    const bundle = await v.decrypt(blob!);
    expect(bundle.accessToken).toBe(BUNDLE.accessToken);
  });

  it("delete() removes the file", async () => {
    const v = new TokenVault(dir, safeStorageMock as never);
    await v.persist(BUNDLE);
    await v.delete();
    expect(await v.load()).toBeNull();
    await v.delete(); // idempotent
  });

  it("isFresh checks the 24h window", () => {
    const v = new TokenVault(dir, safeStorageMock as never);
    expect(v.isFresh(BUNDLE, BUNDLE.gotAt + 1000)).toBe(true);
    expect(v.isFresh(BUNDLE, BUNDLE.gotAt + 86_400_000)).toBe(false);
  });
});
