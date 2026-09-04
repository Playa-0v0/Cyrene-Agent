import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CURRENT_PLUGIN_API_VERSION } from "./api";
import { validateManifestData } from "./manifest-validation";
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
const ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const ICON_MAX_BYTES = 2 * 1024 * 1024;
let esmImportGeneration = 0;
const importEsmModule = require("./native-import.cjs") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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
    const raw = JSON.parse(manifestText) as unknown;
    // 第一层：Schema 校验结构、类型、枚举和必填字段（含 deps 能力白名单）。
    const validated = validateManifestData(raw);
    if (!validated.ok || !validated.value) {
      return { manifest: null, error: validated.error ?? "manifest 结构不合法" };
    }
    const input = validated.value;
    // 第二层：格式与文件系统校验，Schema 无法表达的部分。
    if (input.apiVersion !== CURRENT_PLUGIN_API_VERSION) {
      return {
        manifest: null,
        error: `不兼容的 apiVersion: ${String(input.apiVersion)}（当前支持 ${CURRENT_PLUGIN_API_VERSION}）`,
      };
    }
    if (typeof input.id !== "string" || !ID_RE.test(input.id)) {
      return { manifest: null, error: "id 不符合小写连字符格式" };
    }
    if (typeof input.name !== "string" || !input.name.trim()) return { manifest: null, error: "name 不能为空" };
    if (typeof input.version !== "string" || !SEMVER_RE.test(input.version)) {
      return { manifest: null, error: "version 必须是合法 SemVer" };
    }
    if (typeof input.entry !== "string" || !input.entry) return { manifest: null, error: "entry 不能为空" };
    if (path.basename(input.entry) !== input.entry) return { manifest: null, error: "entry 必须是插件目录内的裸文件名" };
    if (!ENTRY_EXTENSIONS.has(path.extname(input.entry).toLowerCase())) {
      return { manifest: null, error: "entry 扩展名仅支持 .cjs/.js/.mjs" };
    }
    // deps 枚举合法性已由 Schema 保证，这里只做去重归一化。
    const deps: PluginCapability[] | undefined = input.deps
      ? (Array.from(new Set(input.deps)) as PluginCapability[])
      : undefined;

    const entryPath = path.join(dir, input.entry);
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      return { manifest: null, error: `入口文件不存在: ${input.entry}` };
    }
    const realDir = realpathSync(dir);
    const realEntry = realpathSync(entryPath);
    const relativeEntry = path.relative(realDir, realEntry);
    if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
      return { manifest: null, error: "entry 不能通过链接指向插件目录外" };
    }

    const manifest: PluginManifest = {
      apiVersion: CURRENT_PLUGIN_API_VERSION,
      id: input.id,
      name: input.name.trim(),
      version: input.version,
      description: input.description.trim(),
      author: input.author.trim(),
      entry: input.entry,
      icon: resolveIcon(dir, input.icon),
      defaultEnabled: input.defaultEnabled !== false,
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
    const specifier = new URL(pathToFileURL(entry).href);
    esmImportGeneration += 1;
    specifier.searchParams.set(
      "cyreneReload",
      `${record.fingerprint}-${Date.now()}-${esmImportGeneration}`,
    );
    mod = await importEsmModule(specifier.href);
  } else {
    mod = require(entry) as Record<string, unknown>;
  }
  const plugin = (mod.default ?? mod) as Partial<CyrenePlugin>;
  if (typeof plugin.register !== "function") {
    throw new Error(`插件 ${record.manifest.id} 入口未导出 register()`);
  }
  return plugin as CyrenePlugin;
}
