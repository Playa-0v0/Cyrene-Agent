// 校验 @cyrene/plugin-sdk 打包质量：
// 1. manifest.schema.json 与 PluginManifestInput 类型无漂移（generate-schema --check）
// 2. 包内 vendored api.ts 与宿主 src/plugins/api.ts 逐字节一致
// 3. npm pack --dry-run 文件清单只含 dist、package.json、README.md
// 4. 产物（d.ts 与 js）中不存在指向 src/main、src/renderer 等内部路径的模块引用
// 5. CJS 与 ESM 双入口都能加载并导出关键常量
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdkDir = path.join(repoRoot, "packages", "plugin-sdk");

function fail(message) {
  console.error(`[verify-package] ${message}`);
  process.exit(1);
}

// npm 的 cli 入口随 Node 发行（node_modules/npm/bin/npm-cli.js），
// 直接用 node 驱动，避免 Windows 上派生 .cmd 的已知问题
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

// 1. Schema 无漂移
execFileSync(
  process.execPath,
  [path.join(repoRoot, "scripts/plugin-sdk/generate-schema.mjs"), "--check"],
  { cwd: repoRoot, stdio: "inherit" },
);

// 2. vendored api.ts 无漂移
const hostApi = await readFile(path.join(repoRoot, "src/plugins/api.ts"), "utf8");
const vendoredApi = await readFile(path.join(sdkDir, "src/api.ts"), "utf8");
if (hostApi !== vendoredApi) {
  fail("packages/plugin-sdk/src/api.ts 与 src/plugins/api.ts 不一致，请运行 npm run build:plugin-sdk");
}

// 3. npm pack 文件清单
const packOutput = execFileSync(
  process.execPath,
  [npmCli, "pack", "--dry-run"],
  { cwd: sdkDir, encoding: "utf8" },
);
const packedFiles = [...packOutput.matchAll(/^\s+\S*\s+(\S+)$/gm)].map((m) => m[1]).filter((f) => f.includes("/"));
const allowed = /^(dist\/|package\.json$|README\.md$)/;
const unexpected = packedFiles.filter((f) => !allowed.test(f.replace(/\\/g, "/")));
if (unexpected.length > 0) {
  fail(`npm pack 将包含意外文件: ${unexpected.join(", ")}`);
}

// 4. 产物不存在指向内部路径的模块引用（只匹配 import/require 路径，注释文本不算）
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}
const distFiles = await walk(path.join(sdkDir, "dist"));
const forbiddenImport = /(from\s+["']|require\(\s*["']|import\(\s*["'])(\.\.\/\.\.\/|src\/(main|renderer|shared|plugins))/;
for (const file of distFiles.filter((f) => /\.(d\.ts|js|mjs)$/.test(f))) {
  const content = await readFile(file, "utf8");
  if (forbiddenImport.test(content)) {
    fail(`${path.relative(sdkDir, file)} 引用了内部路径（src/main、src/renderer 等）`);
  }
}

// 5. 双入口可加载且导出关键常量
const requireCjs = createRequire(path.join(sdkDir, "dist/cjs-probe.cjs"));
const cjsMain = requireCjs(path.join(sdkDir, "dist/index.js"));
const cjsTesting = requireCjs(path.join(sdkDir, "dist/testing/index.js"));
for (const key of ["CURRENT_PLUGIN_API_VERSION", "PLUGIN_CAPABILITIES", "PLUGIN_HOST_ERROR_CODES", "validateManifestData"]) {
  if (!(key in cjsMain)) fail(`CJS 主入口缺少导出: ${key}`);
}
for (const key of ["createMockPluginContext", "assertPluginTool", "assertValidManifest"]) {
  if (!(key in cjsTesting)) fail(`CJS testing 入口缺少导出: ${key}`);
}
const esmMain = await import(`file://${path.join(sdkDir, "dist/esm/index.mjs").replace(/\\/g, "/")}`);
if (esmMain.CURRENT_PLUGIN_API_VERSION !== cjsMain.CURRENT_PLUGIN_API_VERSION) {
  fail("ESM 与 CJS 主入口的 API 版本常量不一致");
}

console.log("[verify-package] plugin-sdk 打包校验全部通过");
