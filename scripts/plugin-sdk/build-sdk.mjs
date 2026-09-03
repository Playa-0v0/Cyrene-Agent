// 构建 @playa0v0/cyrene-plugin-sdk：
// 1. 从 src/plugins/api.ts 与 manifest.schema.json 原样同步公开契约（单一事实来源）
// 2. tsc 产出 CJS 与类型声明到 dist/
// 3. esbuild 产出 ESM 到 dist/esm/
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdkDir = path.join(repoRoot, "packages", "plugin-sdk");
const sdkSrc = path.join(sdkDir, "src");

// 同步契约文件：不加任何改动，verify-package.mjs 依赖逐字节一致防漂移
await cp(path.join(repoRoot, "src/plugins/api.ts"), path.join(sdkSrc, "api.ts"));
await cp(
  path.join(repoRoot, "src/plugins/manifest.schema.json"),
  path.join(sdkSrc, "manifest.schema.json"),
);

const dist = path.join(sdkDir, "dist");
await rm(dist, { recursive: true, force: true });

// tsc：CJS + d.ts（直接驱动仓库内 TypeScript 的 js 入口，避免跨平台 .cmd 派生问题）
execFileSync(
  process.execPath,
  [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(sdkDir, "tsconfig.json")],
  { cwd: repoRoot, stdio: "inherit" },
);

// esbuild：ESM 双入口（JSON Schema 内联进产物，运行时只剩 ajv 一个外部依赖）
for (const [entry, outfile] of [
  ["src/index.ts", "dist/esm/index.mjs"],
  ["src/testing/index.ts", "dist/esm/testing/index.mjs"],
]) {
  await build({
    entryPoints: [path.join(sdkDir, entry)],
    outfile: path.join(sdkDir, outfile),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    packages: "external",
  });
}

console.log("plugin-sdk 构建完成");
