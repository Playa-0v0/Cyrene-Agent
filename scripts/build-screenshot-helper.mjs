import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyScreenshotHelper } from "./verify-screenshot-helper.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(
  repoRoot,
  "native",
  "cyrene-screenshot",
  "Cargo.toml",
);
const builtHelperPath = path.join(
  repoRoot,
  "native",
  "cyrene-screenshot",
  "target",
  "release",
  "cyrene-screenshot.exe",
);
const stagedHelperPath = path.join(
  repoRoot,
  "resources",
  "bin",
  "cyrene-screenshot.exe",
);

const result = spawnSync("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  manifestPath,
], {
  cwd: repoRoot,
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[screenshot-helper] failed to launch Cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await mkdir(path.dirname(stagedHelperPath), { recursive: true });
await copyFile(builtHelperPath, stagedHelperPath);
const verified = await verifyScreenshotHelper(stagedHelperPath);
console.log(
  `[screenshot-helper] staged ${verified.helperPath} (${verified.size} bytes)`,
);
