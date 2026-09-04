import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import extract from "extract-zip";
import { inspectPluginDir } from "./loader";
import type { PluginManifest } from "./types";

export const PLUGIN_ZIP_LIMITS = {
  archiveBytes: 50 * 1024 * 1024,
  entries: 2_000,
  entryBytes: 50 * 1024 * 1024,
  expandedBytes: 200 * 1024 * 1024,
  compressionRatio: 200,
} as const;

export interface PreparedPluginZip {
  stagingDir: string;
  pluginDir: string;
  manifest: PluginManifest;
}

function validateEntryName(fileName: string): string {
  if (!fileName || fileName.includes("\0")) throw new Error("ZIP 包含空文件名或 NUL 字符");
  const normalized = fileName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`ZIP 包含绝对路径: ${fileName}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error(`ZIP 包含不安全路径: ${fileName}`);
  }
  if (segments.some((segment) => /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`ZIP 包含 Windows 不支持的路径: ${fileName}`);
  }
  return normalized.replace(/\/+$/, "").toLowerCase();
}

async function assertNoLinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`ZIP 不允许包含符号链接: ${entry.name}`);
    if (info.isDirectory()) await assertNoLinks(target);
    else if (!info.isFile()) throw new Error(`ZIP 包含不支持的文件类型: ${entry.name}`);
  }
}

async function locatePluginDirectory(stagingDir: string): Promise<string> {
  if (existsSync(path.join(stagingDir, "manifest.json"))) return stagingDir;
  const entries = (await readdir(stagingDir, { withFileTypes: true }))
    .filter((entry) => entry.name !== "__MACOSX");
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    throw new Error("ZIP 必须在根目录或唯一的顶层目录中包含 manifest.json");
  }
  return path.join(stagingDir, entries[0].name);
}

export async function preparePluginZip(
  zipPath: string,
  userPluginRoot: string,
): Promise<PreparedPluginZip> {
  if (path.extname(zipPath).toLowerCase() !== ".zip") throw new Error("只能导入 .zip 插件包");
  const archive = await stat(zipPath);
  if (!archive.isFile()) throw new Error("所选路径不是普通 ZIP 文件");
  if (archive.size > PLUGIN_ZIP_LIMITS.archiveBytes) throw new Error("ZIP 文件超过 50 MiB 限制");

  await mkdir(userPluginRoot, { recursive: true });
  const stagingBase = path.join(path.dirname(userPluginRoot), "plugin-install-staging");
  await mkdir(stagingBase, { recursive: true });
  const stagingDir = path.join(stagingBase, randomUUID());
  let entryCount = 0;
  let expandedBytes = 0;
  const entryNames = new Set<string>();
  try {
    await extract(zipPath, {
      dir: stagingDir,
      onEntry(entry) {
        const entryName = validateEntryName(entry.fileName);
        if (entryNames.has(entryName)) throw new Error(`ZIP 包含重复或大小写冲突路径: ${entry.fileName}`);
        entryNames.add(entryName);
        entryCount += 1;
        if (entryCount > PLUGIN_ZIP_LIMITS.entries) throw new Error("ZIP 文件条目超过 2000 项限制");
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error("不支持加密 ZIP");
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) throw new Error(`ZIP 不允许包含符号链接: ${entry.fileName}`);
        if (entry.uncompressedSize > PLUGIN_ZIP_LIMITS.entryBytes) {
          throw new Error(`ZIP 单文件解压后超过 50 MiB: ${entry.fileName}`);
        }
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > PLUGIN_ZIP_LIMITS.expandedBytes) throw new Error("ZIP 解压总量超过 200 MiB 限制");
        if (
          entry.uncompressedSize > 1024 * 1024
          && (entry.compressedSize === 0
            || entry.uncompressedSize / entry.compressedSize > PLUGIN_ZIP_LIMITS.compressionRatio)
        ) {
          throw new Error(`ZIP 条目压缩比异常: ${entry.fileName}`);
        }
      },
    });
    await assertNoLinks(stagingDir);
    const pluginDir = await locatePluginDirectory(stagingDir);
    const inspected = inspectPluginDir(pluginDir);
    if (!inspected.manifest) throw new Error(inspected.error ?? "插件 manifest 校验失败");
    return { stagingDir, pluginDir, manifest: inspected.manifest };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function discardPreparedPlugin(prepared: PreparedPluginZip): Promise<void> {
  await rm(prepared.stagingDir, { recursive: true, force: true });
}

export async function commitPreparedPlugin(
  prepared: PreparedPluginZip,
  userPluginRoot: string,
  replace: boolean,
): Promise<string> {
  const destination = path.join(userPluginRoot, prepared.manifest.id);
  const backupRoot = path.join(path.dirname(userPluginRoot), "plugin-install-backups");
  const backup = path.join(backupRoot, `${prepared.manifest.id}-${randomUUID()}`);
  const destinationExists = existsSync(destination);
  if (destinationExists && !replace) throw new Error(`插件已存在: ${prepared.manifest.id}`);

  let backedUp = false;
  try {
    if (destinationExists) {
      await mkdir(backupRoot, { recursive: true });
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(prepared.pluginDir, destination);
  } catch (error) {
    if (backedUp && !existsSync(destination)) await rename(backup, destination);
    throw error;
  } finally {
    await rm(prepared.stagingDir, { recursive: true, force: true });
  }
  if (backedUp) {
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[plugins] 已安装 ${prepared.manifest.id}，但旧版本备份清理失败:`, error);
    }
  }
  return destination;
}
