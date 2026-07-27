import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";

const VAULT_PREFIX = "cyvault:v1:";

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return normalized === "pass"
    || normalized.endsWith("password")
    || normalized.endsWith("pass")
    || normalized.includes("apikey")
    || normalized.endsWith("key")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized === "accesskeyid";
}

export function isProtectedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(VAULT_PREFIX);
}

export function protectSecret(value: string): string {
  if (!value || isProtectedSecret(value) || !safeStorage.isEncryptionAvailable()) return value;
  return VAULT_PREFIX + safeStorage.encryptString(value).toString("base64");
}

export function revealSecret(value: string): string {
  if (!isProtectedSecret(value)) return value;
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(VAULT_PREFIX.length), "base64"));
  } catch {
    return "";
  }
}

function transformSecrets(value: unknown, mode: "protect" | "reveal" | "redact", key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => transformSecrets(item, mode));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      transformSecrets(child, mode, childKey),
    ]));
  }
  if (typeof value !== "string" || !isSecretKey(key)) return value;
  if (mode === "redact") return "";
  return mode === "protect" ? protectSecret(value) : revealSecret(value);
}

export function protectSecrets<T>(value: T): T {
  return transformSecrets(value, "protect") as T;
}

export function revealSecrets<T>(value: T): T {
  return transformSecrets(value, "reveal") as T;
}

export function redactSecrets<T>(value: T): T {
  return transformSecrets(value, "redact") as T;
}

export function preserveCurrentSecrets<T>(incoming: T, current: unknown, key = ""): T {
  if (typeof incoming === "string" && isSecretKey(key) && !incoming && typeof current === "string") return current as T;
  if (Array.isArray(incoming)) {
    const currentItems = Array.isArray(current) ? current : [];
    return incoming.map((item, index) => preserveCurrentSecrets(item, currentItems[index])) as T;
  }
  if (incoming && typeof incoming === "object") {
    const currentObject = current && typeof current === "object" ? current as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(incoming as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      preserveCurrentSecrets(child, currentObject[childKey], childKey),
    ])) as T;
  }
  return incoming;
}

export interface VaultStatus {
  available: boolean;
  backend: string;
  protectedCount: number;
  plaintextCount: number;
  lockedCount: number;
}

function countSecrets(value: unknown, key = "", counters = { protectedCount: 0, plaintextCount: 0, lockedCount: 0 }): typeof counters {
  if (Array.isArray(value)) {
    value.forEach((item) => countSecrets(item, "", counters));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => countSecrets(child, childKey, counters));
  } else if (typeof value === "string" && isSecretKey(key) && value) {
    if (isProtectedSecret(value)) {
      counters.protectedCount += 1;
      if (!safeStorage.isEncryptionAvailable() || !revealSecret(value)) counters.lockedCount += 1;
    } else {
      counters.plaintextCount += 1;
    }
  }
  return counters;
}

export function getVaultStatus(files: string[]): VaultStatus {
  const counters = { protectedCount: 0, plaintextCount: 0, lockedCount: 0 };
  for (const file of files) {
    try {
      if (fs.existsSync(file)) countSecrets(JSON.parse(fs.readFileSync(file, "utf8")), "", counters);
    } catch { /* damaged settings are reported by their normal loader */ }
  }
  return {
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === "darwin" ? "macOS Keychain" : process.platform === "win32" ? "Windows DPAPI" : "系統密鑰服務",
    ...counters,
  };
}

export function migrateFilesToVault(files: string[]): VaultStatus {
  if (!safeStorage.isEncryptionAvailable()) return getVaultStatus(files);
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const protectedValue = protectSecrets(parsed);
      const temp = `${file}.vault-${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(protectedValue, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      console.warn("[Vault] 無法遷移設定檔:", file, error);
    }
  }
  return getVaultStatus(files);
}
