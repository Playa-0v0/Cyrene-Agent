import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createPluginSecretsService, type SafeStorageLike } from "./secrets-service";

/** 可逆的假加密（前缀 + base64），用于验证服务只落 encryptString 的输出。 */
function fakeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`enc:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not encrypted by fake");
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    },
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-secrets-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function serviceFor(pluginId: string, storage: SafeStorageLike = fakeStorage(), signal?: AbortSignal) {
  return createPluginSecretsService({
    pluginId,
    secretsRoot: path.join(tmp, pluginId, "secrets"),
    storage,
    signal,
  });
}

describe("插件密钥服务", () => {
  it("set/get/delete 完整往返且不留临时文件", async () => {
    const svc = serviceFor("demo");
    await svc.set("api-token", "secret-value");
    expect(await svc.get("api-token")).toBe("secret-value");
    expect(readdirSync(path.join(tmp, "demo", "secrets")).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(await svc.delete("api-token")).toBe(true);
    expect(await svc.get("api-token")).toBeUndefined();
  });

  it("delete 幂等：不存在的 key 返回 false", async () => {
    const svc = serviceFor("demo");
    expect(await svc.delete("missing")).toBe(false);
  });

  it("大小写不同的 key 相互独立", async () => {
    const svc = serviceFor("demo");
    await svc.set("Token", "upper");
    await svc.set("token", "lower");
    expect(await svc.get("Token")).toBe("upper");
    expect(await svc.get("token")).toBe("lower");
  });

  it("Windows 保留名形状的 key 可正常使用（文件名是哈希）", async () => {
    const svc = serviceFor("demo");
    await svc.set("CON", "console");
    await svc.set("PRN", "printer");
    expect(await svc.get("CON")).toBe("console");
    expect(await svc.get("PRN")).toBe("printer");
    // 目录里只有十六进制哈希文件名，没有 key 原文
    for (const file of readdirSync(path.join(tmp, "demo", "secrets"))) {
      expect(file).toMatch(/^[0-9a-f]{64}\.enc$/);
    }
  });

  it("落盘内容是 encryptString 的输出，不含明文", async () => {
    const svc = serviceFor("demo");
    await svc.set("api-token", "plaintext-secret");
    const dir = path.join(tmp, "demo", "secrets");
    const file = readdirSync(dir)[0];
    expect(readFileSync(path.join(dir, file), "utf8")).not.toContain("plaintext-secret");
  });

  it("两个插件的密钥目录隔离，互不可见", async () => {
    const a = serviceFor("plugin-a");
    const b = serviceFor("plugin-b");
    await a.set("shared-key", "a-value");
    expect(await b.get("shared-key")).toBeUndefined();
    expect(existsSync(path.join(tmp, "plugin-a", "secrets"))).toBe(true);
    expect(existsSync(path.join(tmp, "plugin-b", "secrets"))).toBe(false);
  });

  it("非法 key 返回 E_INVALID_ARGUMENT", async () => {
    const svc = serviceFor("demo");
    for (const key of ["", "a/b", "a\\b", "a b", "a:b", ".hidden", "x".repeat(65)]) {
      await expect(svc.get(key)).rejects.toSatisfy((err: unknown) => isPluginHostError(err) && err.code === "E_INVALID_ARGUMENT");
    }
  });

  it("值不是字符串返回 E_INVALID_ARGUMENT", async () => {
    const svc = serviceFor("demo");
    await expect(svc.set("k", 42 as unknown as string)).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_INVALID_ARGUMENT",
    );
  });

  it("安全存储不可用时 set/get 返回 E_STORAGE_UNAVAILABLE 且不落文件", async () => {
    const svc = serviceFor("demo", fakeStorage(false));
    await expect(svc.set("k", "v")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_STORAGE_UNAVAILABLE",
    );
    await expect(svc.get("k")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_STORAGE_UNAVAILABLE",
    );
    expect(existsSync(path.join(tmp, "demo", "secrets"))).toBe(false);
  });

  it("插件停止后所有调用返回 E_PLUGIN_STOPPING", async () => {
    const controller = new AbortController();
    const svc = serviceFor("demo", fakeStorage(), controller.signal);
    await svc.set("k", "v");
    controller.abort();
    await expect(svc.get("k")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
    await expect(svc.set("k", "v")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
    await expect(svc.delete("k")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_PLUGIN_STOPPING",
    );
  });

  it("解密失败返回 E_INTERNAL", async () => {
    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, "utf8"),
      decryptString: () => {
        throw new Error("corrupt");
      },
    };
    const svc = serviceFor("demo", broken);
    await svc.set("k", "v");
    await expect(svc.get("k")).rejects.toSatisfy(
      (err: unknown) => isPluginHostError(err) && err.code === "E_INTERNAL",
    );
  });
});
