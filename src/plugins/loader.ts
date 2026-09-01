import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CURRENT_PLUGIN_API_VERSION } from "./api";
import type {
  CyrenePlugin,
  PluginCapability,
  PluginManifest,
  PluginRecord,
  PluginSource,
} from "./types";

const MANIFEST_FILE = "manifest.json";
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const DEPS_ALLOWED = new Set(["channels", "llm", "permissions", "subprocess"]);
const ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const ICON_MAX_BYTES = 2 * 1024 * 1024;
let esmImportGeneration = 0;

export interface PluginScanIssue {
  root: string;
  path?: string;
  source: PluginSource;
  message: string;
}

export interface ManifestInspection {
  manifest: PluginManifest | null;
  error?: string;
  fingerprint?: string;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 图标是纯装饰字段：声明了但不合法（非裸文件名 / 扩展名不支持 / 文件缺失 /
 * 链接指向目录外 / 超过 2MiB）时静默忽略，不让整个插件加载失败。
 */
function resolveIcon(dir: string, icon: unknown): string | undefined {
  if (icon === undefined || icon === null || icon === "") return undefined;
  if (typeof icon !== "string") return undefined;
  if (path.basename(icon) !== icon) return undefined;
  if (!ICON_EXTENSIONS.has(path.extname(icon).toLowerCase())) return undefined;
  const iconPath = path.join(dir, icon);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(iconPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > ICON_MAX_BYTES) return undefined;
  try {
    const realDir = realpathSync(dir);
    const realIcon = realpathSync(iconPath);
    const relative = path.relative(realDir, realIcon);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  } catch {
    return undefined;
  }
  return icon;
}

export function inspectPluginDir(dir: string): ManifestInspection {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { manifest: null, error: "缺少 manifest.json" };
  try {
    const manifestText = readFileSync(manifestPath, "utf8");
    const raw = JSON.parse(manifestText) as Partial<PluginManifest> | null;
    if (!raw || typeof raw !== "object") return { manifest: null, error: "manifest 必须是对象" };
    if (raw.apiVersion !== CURRENT_PLUGIN_API_VERSION) {
      return {
        manifest: null,
        error: `不兼容的 apiVersion: ${String(raw.apiVersion)}（当前支持 ${CURRENT_PLUGIN_API_VERSION}）`,
      };
    }
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      return { manifest: null, error: "id 不符合小写连字符格式" };
    }
    if (typeof raw.name !== "string" || !raw.name.trim()) return { manifest: null, error: "name 不能为空" };
    if (typeof raw.version !== "string" || !SEMVER_RE.test(raw.version)) {
      return { manifest: null, error: "version 必须是合法 SemVer" };
    }
    if (typeof raw.description !== "string" || !raw.description.trim()) {
      return { manifest: null, error: "description 不能为空" };
    }
    if (typeof raw.author !== "string" || !raw.author.trim()) return { manifest: null, error: "author 不能为空" };
    if (typeof raw.entry !== "string" || !raw.entry) return { manifest: null, error: "entry 不能为空" };
    if (path.basename(raw.entry) !== raw.entry) return { manifest: null, error: "entry 必须是插件目录内的裸文件名" };
    if (!ENTRY_EXTENSIONS.has(path.extname(raw.entry).toLowerCase())) {
      return { manifest: null, error: "entry 扩展名仅支持 .cjs/.js/.mjs" };
    }
    if (raw.defaultEnabled !== undefined && typeof raw.defaultEnabled !== "boolean") {
      return { manifest: null, error: "defaultEnabled 必须是布尔值" };
    }
    let deps: PluginCapability[] | undefined;
    if (raw.deps !== undefined) {
      if (!Array.isArray(raw.deps)) return { manifest: null, error: "deps 必须是数组" };
      if (raw.deps.some((dep) => typeof dep !== "string" || !DEPS_ALLOWED.has(dep))) {
        return { manifest: null, error: "deps 包含未知主程序能力" };
      }
      deps = Array.from(new Set(raw.deps)) as PluginCapability[];
    }

    const entryPath = path.join(dir, raw.entry);
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      return { manifest: null, error: `入口文件不存在: ${raw.entry}` };
    }
    const realDir = realpathSync(dir);
    const realEntry = realpathSync(entryPath);
    const relativeEntry = path.relative(realDir, realEntry);
    if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
      return { manifest: null, error: "entry 不能通过链接指向插件目录外" };
    }

    const manifest: PluginManifest = {
      apiVersion: CURRENT_PLUGIN_API_VERSION,
      id: raw.id,
      name: raw.name.trim(),
      version: raw.version,
      description: raw.description.trim(),
      author: raw.author.trim(),
      entry: raw.entry,
      icon: resolveIcon(dir, raw.icon),
      defaultEnabled: raw.defaultEnabled !== false,
      deps,
    };
    const fingerprint = createHash("sha256")
      .update(manifestText)
      .update("\0")
      .update(readFileSync(realEntry))
      .digest("hex");
    return { manifest, fingerprint };
  } catch (error) {
    return { manifest: null, error: asErrorMessage(error) };
  }
}

/** 读取并校验 manifest；不合法返回 null（调用方跳过并留痕日志） */
export function readManifest(dir: string): PluginManifest | null {
  return inspectPluginDir(dir).manifest;
}

/** 扫描 root 下所有一级子目录，收集带合法 manifest 的插件 */
export function scanPluginDir(
  root: string,
  source: PluginSource = "user",
  onIssue?: (issue: PluginScanIssue) => void,
): PluginRecord[] {
  if (!existsSync(root)) return [];
  const out: PluginRecord[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    const issue = { root, source, message: `无法扫描插件目录: ${asErrorMessage(error)}` } satisfies PluginScanIssue;
    onIssue?.(issue);
    console.warn(`[plugins] ${issue.message}: ${root}`);
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const inspected = inspectPluginDir(dir);
    if (!inspected.manifest || !inspected.fingerprint) {
      const issue = {
        root,
        path: dir,
        source,
        message: inspected.error ?? "无效 manifest",
      } satisfies PluginScanIssue;
      onIssue?.(issue);
      console.warn(`[plugins] 忽略无效插件目录: ${dir} (${issue.message})`);
      continue;
    }
    out.push({
      manifest: inspected.manifest,
      dir,
      source,
      fingerprint: inspected.fingerprint,
    });
  }
  return out;
}

/** Remove cached CommonJS modules owned by one plugin before reactivation. */
export function clearPluginModuleCache(pluginDir: string): void {
  const root = path.resolve(pluginDir);
  for (const modulePath of Object.keys(require.cache)) {
    const relative = path.relative(root, modulePath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      delete require.cache[modulePath];
    }
  }
}

/** 动态加载插件入口（.cjs/.js/.mjs 均可），归一化 default/named export */
export async function loadPlugin(record: PluginRecord): Promise<CyrenePlugin> {
  const entry = path.join(record.dir, record.manifest.entry);
  const ext = path.extname(entry).toLowerCase();
  let mod: Record<string, unknown>;
  clearPluginModuleCache(record.dir);
  if (ext === ".mjs") {
    // commonjs 编译会把 import() 改写为 require()，require 无法加载 file:// URL，
    // 因此 ESM 入口经运行时 import 加载（new Function 避开 tsc 改写）。
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<Record<string, unknown>>;
    const specifier = new URL(pathToFileURL(entry).href);
    esmImportGeneration += 1;
    specifier.searchParams.set(
      "cyreneReload",
      `${record.fingerprint}-${Date.now()}-${esmImportGeneration}`,
    );
    mod = await dynamicImport(specifier.href);
  } else {
    mod = require(entry) as Record<string, unknown>;
  }
  const plugin = (mod.default ?? mod) as Partial<CyrenePlugin>;
  if (typeof plugin.register !== "function") {
    throw new Error(`插件 ${record.manifest.id} 入口未导出 register()`);
  }
  return plugin as CyrenePlugin;
}
