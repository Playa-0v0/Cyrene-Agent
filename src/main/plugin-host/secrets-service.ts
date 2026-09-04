import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { PluginSecretsService } from "../../plugins/api";
import { pluginHostError } from "./errors";

/** 与普通插件存储一致的 key 约束，先于文件名哈希校验。 */
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Electron safeStorage 的最小接口；宿主装配时注入真实现，测试注入假件。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface PluginSecretsServiceOptions {
  pluginId: string;
  /** 密钥目录，约定为 plugin-data/<pluginId>/secrets/。 */
  secretsRoot: string;
  storage: SafeStorageLike;
  /** 插件停止信号；停止后所有调用返回 E_PLUGIN_STOPPING。 */
  signal?: AbortSignal;
}

export function createPluginSecretsService(options: PluginSecretsServiceOptions): PluginSecretsService {
  const { pluginId, secretsRoot, storage, signal } = options;
  const logPrefix = `plugin:${pluginId}:secrets`;

  function assertActive(): void {
    if (signal?.aborted) {
      throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${pluginId} 已停止，密钥服务不可用`);
    }
  }

  function assertKey(key: string): void {
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      throw pluginHostError("E_INVALID_ARGUMENT", `非法密钥 key: ${String(key)}`);
    }
  }

  // 文件名取 key 的 SHA-256，key 原文不进文件系统：大小写不同的 key
  // 天然独立，也避开 CON、PRN 等 Windows 保留名，未来扩展 key 规则不受限。
  function fileFor(key: string): string {
    const hash = createHash("sha256").update(key, "utf8").digest("hex");
    return path.join(secretsRoot, `${hash}.enc`);
  }

  return {
    async get(key) {
      assertActive();
      assertKey(key);
      if (!storage.isEncryptionAvailable()) {
        throw pluginHostError("E_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法读取插件密钥");
      }
      let encrypted: Buffer;
      try {
        encrypted = await fs.readFile(fileFor(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw pluginHostError("E_INTERNAL", "读取密钥文件失败", { cause: err, logPrefix });
      }
      try {
        return storage.decryptString(encrypted);
      } catch (err) {
        throw pluginHostError("E_INTERNAL", "解密密钥失败", { cause: err, logPrefix });
      }
    },

    async set(key, value) {
      assertActive();
      assertKey(key);
      if (typeof value !== "string") {
        throw pluginHostError("E_INVALID_ARGUMENT", "密钥值必须是字符串");
      }
      // 安全存储不可用时直接失败，不落任何弱保护文件。
      if (!storage.isEncryptionAvailable()) {
        throw pluginHostError("E_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法保存插件密钥");
      }
      const target = fileFor(key);
      const tmp = `${target}.tmp`;
      try {
        await fs.mkdir(secretsRoot, { recursive: true });
        // 原子写：先写临时文件再替换，崩溃不会留下半个密钥文件。
        await fs.writeFile(tmp, storage.encryptString(value));
        await fs.rename(tmp, target);
      } catch (err) {
        throw pluginHostError("E_INTERNAL", "写入密钥文件失败", { cause: err, logPrefix });
      }
    },

    async delete(key) {
      assertActive();
      assertKey(key);
      try {
        await fs.unlink(fileFor(key));
        return true;
      } catch (err) {
        // 幂等：不存在的 key 视为已删除，返回 false 而不是报错。
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw pluginHostError("E_INTERNAL", "删除密钥文件失败", { cause: err, logPrefix });
      }
    },
  };
}
