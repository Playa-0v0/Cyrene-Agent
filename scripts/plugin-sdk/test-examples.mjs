// 示例插件端到端验证：模拟仓库外空项目，只用打包后的 SDK 编译并冒烟测试四个示例。
// 流程：构建 SDK → npm pack → 临时空项目安装 tarball → tsc 编译四个示例 →
//       组装可安装目录（manifest.json + index.cjs）→ Mock Context 冒烟注册与契约断言。
import { cp, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdkDir = path.join(repoRoot, "packages", "plugin-sdk");
const examplesDir = path.join(repoRoot, "examples");
const exampleIds = ["weather-tool", "long-term-memory", "scheduled-automation", "local-asr-contract"];

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const tscJs = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function fail(message) {
  console.error(`[test-examples] ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// 1. 构建 SDK 并打包（保证 tarball 来自当前源码）
run(process.execPath, [path.join(repoRoot, "scripts/plugin-sdk/build-sdk.mjs")]);
const packOutput = execFileSync(process.execPath, [npmCli, "pack"], {
  cwd: sdkDir,
  encoding: "utf8",
});
const tarballName = packOutput.trim().split("\n").at(-1)?.trim();
if (!tarballName?.endsWith(".tgz")) fail("npm pack 未返回 tarball 文件名");
const tarball = path.join(sdkDir, tarballName);

// 2. 临时空项目
const projectDir = await mkdtemp(path.join(tmpdir(), "cyrene-plugin-examples-"));
try {
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    name: "plugin-example-e2e",
    private: true,
  }, null, 2));

  // 3. 安装打包后的 SDK（ ajv 由 npm 从 registry/缓存解析）
  run(process.execPath, [npmCli, "install", "--no-save", "--no-audit", "--no-fund", tarball], {
    cwd: projectDir,
  });

  // 4. 复制示例源码（manifest、tsconfig、index.ts）
  for (const id of exampleIds) {
    const src = path.join(examplesDir, id);
    const dest = path.join(projectDir, "examples", id);
    await cp(src, dest, {
      recursive: true,
      filter: (p) => !p.includes(`${path.sep}dist`) && !p.endsWith(".zip"),
    });
  }

  // 5. 从打包产物编译四个示例
  for (const id of exampleIds) {
    run(process.execPath, [tscJs, "-p", path.join(projectDir, "examples", id, "tsconfig.json")]);
  }

  // 6. 组装可安装目录：manifest.json + index.cjs
  const installRoot = path.join(projectDir, "install");
  for (const id of exampleIds) {
    const built = path.join(projectDir, "examples", id, "dist", "index.js");
    const pluginDir = path.join(installRoot, id);
    await cp(built, path.join(pluginDir, "index.cjs"));
    await cp(path.join(examplesDir, id, "manifest.json"), path.join(pluginDir, "manifest.json"));
  }

  // 7. 冒烟测试：Mock Context 注册 → 工具契约断言 → 停止清理
  const smokeScript = path.join(projectDir, "smoke.mjs");
  await writeFile(smokeScript, await readFile(path.join(repoRoot, "scripts/plugin-sdk/smoke-examples.mjs")));
  run(process.execPath, [smokeScript, installRoot], { cwd: projectDir });

  console.log("[test-examples] 四个示例编译与冒烟测试全部通过");
} finally {
  await rm(tarball, { force: true });
  await rm(projectDir, { recursive: true, force: true });
}
