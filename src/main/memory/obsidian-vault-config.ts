// Obsidian Vault 绑定配置
//
// 持久化保存用户绑定的 vault 路径和自动同步开关。
// 配置文件位于 userData/obsidian-vault-config.json。

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { logger, LogTag } from "../logger";

export interface ObsidianVaultConfig {
  /** 绑定的 vault 目录路径，空串表示未绑定 */
  vaultPath: string;
  /** 自动同步开关：true 时记忆写入后自动触发增量同步到 vault */
  autoSync: boolean;
  /** 上次同步时间戳（ms），用于 UI 展示 */
  lastSyncAt: number;
}

const DEFAULT_CONFIG: ObsidianVaultConfig = {
  vaultPath: "",
  autoSync: false,
  lastSyncAt: 0,
};

function getConfigPath(): string {
  return path.join(app.getPath("userData"), "obsidian-vault-config.json");
}

export function loadObsidianVaultConfig(): ObsidianVaultConfig {
  try {
    const filePath = getConfigPath();
    if (!fs.existsSync(filePath)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ObsidianVaultConfig>;
    return {
      vaultPath: typeof raw.vaultPath === "string" ? raw.vaultPath : "",
      autoSync: typeof raw.autoSync === "boolean" ? raw.autoSync : false,
      lastSyncAt: typeof raw.lastSyncAt === "number" ? raw.lastSyncAt : 0,
    };
  } catch (err) {
    logger.warn(LogTag.Cyrene, `[obsidian-config] load failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveObsidianVaultConfig(patch: Partial<ObsidianVaultConfig>): ObsidianVaultConfig {
  const current = loadObsidianVaultConfig();
  const merged = { ...current, ...patch };
  const filePath = getConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/** 是否已绑定 vault */
export function isVaultBound(): boolean {
  return loadObsidianVaultConfig().vaultPath.length > 0;
}

/** 清除绑定 */
export function unbindVault(): ObsidianVaultConfig {
  return saveObsidianVaultConfig({ vaultPath: "", autoSync: false, lastSyncAt: 0 });
}
