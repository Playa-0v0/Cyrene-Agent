// 生成第三方 skills 快照归档（vendor/cyrene-skills/skills-snapshot.zip）。
//
// 背景：仓库 skills/ 只保留自研 cyrene-* skill，其余第三方 skill（docx/pdf/
// xlsx/pptx、superpowers、ECC、office 等，多为本项目定制裁剪过的本地资产，
// 无法从上游 GitHub 干净拉取）整体打成一份 zip 快照进 git。
// 应用首次启动时把这份归档解压到 userData/skills（见 skills/snapshot-install.ts），
// 让开发版和打包版都拿到完整 skill 集合，同时保持仓库语言统计干净。
//
// 生成：node scripts/packaging/build-skills-snapshot.mjs
// 产物：vendor/cyrene-skills/skills-snapshot.zip + skills-snapshot-manifest.json
//
// 注意：必须先于「从 git 移除第三方 skills」运行，归档是唯一保留这些文件的地方。

import { execFile } from "node:child_process";
import { readFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");
const skillsDir = path.join(projectRoot, "skills");
const vendorDir = path.join(projectRoot, "vendor", "cyrene-skills");

/** 自研 skill（产品本体，留在仓库 skills/，不进归档）。 */
const SELF_SKILLS = new Set([
  "cyrene-learn-tutor",
  "cyrene-plan-mode",
  "cyrene-work-hygiene",
  "cyrene-original-voice",
  "cyrene-obsidian-workspace",
]);

async function collectVendorSkills() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !SELF_SKILLS.has(e.name))
    .map((e) => e.name)
    .sort();
}

/** 用 Windows 原生 Compress-Archive 打包（生成标准 zip，extract-zip 可解）。 */
async function zipWithPowerShell(entries, archivePath) {
  const paths = entries.map((name) => `'${path.join(skillsDir, name).replace(/'/g, "''")}'`);
  const cmd =
    `$ProgressPreference='SilentlyContinue'; ` +
    `Compress-Archive -Path ${paths.join(",")} -DestinationPath '${archivePath.replace(/'/g, "''")}' -CompressionLevel Optimal`;
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    windowsHide: true,
    timeout: 300_000,
  });
}

/** 校验 zip 能解压且每个 skill 目录都有 SKILL.md（防打包不完整）。 */
async function verifyArchive(archivePath, entries) {
  const probeDir = path.join(projectRoot, ".tmp-skills-snapshot-probe");
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true });
  const { default: extract } = await import("extract-zip");
  await extract(archivePath, { dir: probeDir });

  const missing = [];
  for (const name of entries) {
    const mdPath = path.join(probeDir, name, "SKILL.md");
    try {
      await readFile(mdPath, "utf8");
    } catch {
      missing.push(name);
    }
  }
  await rm(probeDir, { recursive: true, force: true });
  if (missing.length > 0) {
    throw new Error(`快照归档校验失败：以下 skill 缺 SKILL.md: ${missing.join(", ")}`);
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(filePath)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

async function main() {
  const entries = await collectVendorSkills();
  const remaining = await readdir(skillsDir, { withFileTypes: true });
  const selfRemaining = remaining.filter((e) => e.isDirectory() && SELF_SKILLS.has(e.name)).map((e) => e.name);
  console.log(`[build-skills-snapshot] 归档 ${entries.length} 个第三方 skill，保留 ${selfRemaining.length} 个自研: ${selfRemaining.join(", ")}`);

  await mkdir(vendorDir, { recursive: true });
  const archivePath = path.join(vendorDir, "skills-snapshot.zip");

  // 没有第三方 skill 可归档：保留既有快照，避免 Compress-Archive 空参数报错
  if (entries.length === 0) {
    console.log("[build-skills-snapshot] 无第三方 skill 可归档，跳过（保留既有快照）");
    return;
  }

  // 先压到临时文件、校验通过后再替换，失败不破坏既有快照
  const stagingPath = path.join(vendorDir, "skills-snapshot.zip.tmp");
  await rm(stagingPath, { force: true });
  await zipWithPowerShell(entries, stagingPath);
  await verifyArchive(stagingPath, entries);
  await rm(archivePath, { force: true });
  await (await import("node:fs")).promises.rename(stagingPath, archivePath);

  const hash = await sha256File(archivePath);
  const stat = await (await import("node:fs")).promises.stat(archivePath);

  const manifest = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    skills: entries,
    sha256: hash,
    byteSize: stat.size,
    selfSkills: [...SELF_SKILLS].sort(),
  };
  await writeFile(
    path.join(vendorDir, "skills-snapshot-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  console.log(`[build-skills-snapshot] 完成: ${archivePath} (${(stat.size / 1024).toFixed(1)} KB, sha256=${hash.slice(0, 12)}…)`);
}

main().catch((err) => {
  console.error("[build-skills-snapshot] 失败:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
