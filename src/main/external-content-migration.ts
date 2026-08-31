import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExternalContentPaths } from "./external-content-paths";

/**
 * 升级迁移：NSIS 安装脚本（installer.nsh）在升级时会把安装目录里的 prompts/skills
 * 挪到同级暂存目录 `.Cyrene.content-preserve`（因为旧版卸载器会 RMDir /r 整个安装目录）。
 * 应用启动时在这里把暂存内容合并进 userData 的用户区：
 * - 与上次启动记录的官方内置内容一致的文件 → 视为未修改的内置文件，丢弃（新版内置随安装已刷新）
 * - 其余文件（用户修改/新增）→ 复制到 userData，此后升级不再丢
 *
 * 判定依据是 content-manifest.json（每次启动记录安装目录内文件的 sha1）。
 * 没有manifest 时（首次升级到本版本），仅恢复新版内置中不存在的文件，避免把
 * 官方更新过的内置文件冻结在旧版本。
 */

const STAGING_DIR_NAME = ".Cyrene.content-preserve";
const MANIFEST_FILE = "content-manifest.json";

interface ContentManifest {
  prompts: Record<string, string>;
  skills: Record<string, string>;
}

export interface StagedContentMigrationInput {
  isPackaged: boolean;
  installRoot: string;
  promptDirectories: string[];
  userSkillDirectories: string[];
}

/** 启动入口：合并暂存内容并刷新 manifest。任何失败都不阻断启动。 */
export function migrateStagedExternalContent(input: StagedContentMigrationInput): void {
  if (!input.isPackaged) return;
  try {
    const stagingDir = path.join(input.installRoot, "..", STAGING_DIR_NAME);
    if (fs.existsSync(stagingDir)) {
      mergeStaging(stagingDir, input);
    }
    writeManifest(input);
  } catch {
    // 迁移失败下次启动重试，不影响主流程
  }
}

function mergeStaging(stagingDir: string, input: StagedContentMigrationInput): void {
  const manifest = readManifest(input);
  const shippedPrompts = shippedPromptDirectory(input);
  const shippedSkills = path.join(input.installRoot, "skills");

  mergeTree(
    path.join(stagingDir, "prompts"),
    input.promptDirectories[0],
    manifest?.prompts,
    shippedPrompts,
  );
  mergeTree(
    path.join(stagingDir, "skills"),
    input.userSkillDirectories[0],
    manifest?.skills,
    shippedSkills,
  );
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

/**
 * 把 stagedRoot 下的文件合并到 userRoot：
 * 1. userRoot 已有同名文件 → 跳过（用户现有内容优先，不覆盖）
 * 2. 有 manifest 且暂存文件与记录的内置 sha1 一致 → 丢弃（未修改的内置文件）
 * 3. 无 manifest 且与新版内置同名文件内容一致 → 丢弃
 * 4. 其余 → 复制到 userRoot（用户修改/新增的内容）
 */
function mergeTree(
  stagedRoot: string,
  userRoot: string,
  manifestHashes: Record<string, string> | undefined,
  shippedRoot: string,
): void {
  if (!userRoot || !fs.existsSync(stagedRoot)) return;
  for (const relativePath of walkFiles(stagedRoot)) {
    const stagedFile = path.join(stagedRoot, relativePath);
    const targetFile = path.join(userRoot, relativePath);
    if (fs.existsSync(targetFile)) continue;

    const stagedHash = sha1File(stagedFile);
    if (manifestHashes) {
      if (manifestHashes[relativePath] === stagedHash) continue;
    } else {
      const shippedFile = path.join(shippedRoot, relativePath);
      if (fs.existsSync(shippedFile) && sha1File(shippedFile) === stagedHash) continue;
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(stagedFile, targetFile);
  }
}

/** userData 下 manifest 的位置（与用户内容同目录）。 */
function manifestPath(input: StagedContentMigrationInput): string {
  return path.join(path.dirname(input.promptDirectories[0]), MANIFEST_FILE);
}

function readManifest(input: StagedContentMigrationInput): ContentManifest | null {
  try {
    const file = manifestPath(input);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ContentManifest>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      prompts: typeof parsed.prompts === "object" && parsed.prompts ? parsed.prompts : {},
      skills: typeof parsed.skills === "object" && parsed.skills ? parsed.skills : {},
    };
  } catch {
    return null;
  }
}

/** 记录安装目录内 prompts/skills 每个文件的 sha1，供下次升级时区分内置与用户修改。 */
function writeManifest(input: StagedContentMigrationInput): void {
  const manifest: ContentManifest = {
    prompts: hashTree(shippedPromptDirectory(input)),
    skills: hashTree(path.join(input.installRoot, "skills")),
  };
  const file = manifestPath(input);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
}

/** 内置 prompts 目录 = promptDirectories 中位于安装目录下的那一项。 */
function shippedPromptDirectory(input: StagedContentMigrationInput): string {
  const fallback = path.join(input.installRoot, "prompts");
  return input.promptDirectories.find((dir) => dir === fallback) ?? fallback;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return files;
}

function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (!fs.existsSync(root)) return hashes;
  for (const relativePath of walkFiles(root)) {
    hashes[relativePath] = sha1File(path.join(root, relativePath));
  }
  return hashes;
}

function sha1File(file: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}
