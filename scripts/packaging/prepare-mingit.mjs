import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline as pipelineCallback } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import extract from "extract-zip";

const execFileAsync = promisify(execFile);
const pipeline = promisify(pipelineCallback);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");

export async function prepareMinGit(options) {
  const { manifest, cacheDir, outputDir } = options;
  const probe = options.probe ?? probeGit;
  const download = options.download ?? downloadFile;
  const unzip = options.extract ?? ((archive, destination) => extract(archive, { dir: destination }));
  const gitPath = path.join(outputDir, "cmd", "git.exe");

  if (await fileExists(gitPath) && await probe(gitPath)) return "cached";

  await mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, manifest.assetName);
  if (!await hasExpectedHash(archive, manifest.sha256)) {
    const partial = `${archive}.partial`;
    await rm(partial, { force: true });
    await download(manifest.url, partial);
    const actual = await sha256File(partial);
    if (actual !== manifest.sha256) {
      await rm(partial, { force: true });
      throw new Error(`MinGit SHA-256 mismatch: expected ${manifest.sha256}, received ${actual}`);
    }
    await rm(archive, { force: true });
    await rename(partial, archive);
  }

  const temporaryOutput = `${outputDir}.tmp-${process.pid}`;
  await rm(temporaryOutput, { recursive: true, force: true });
  await mkdir(temporaryOutput, { recursive: true });
  try {
    await unzip(archive, temporaryOutput);
    const temporaryGit = path.join(temporaryOutput, "cmd", "git.exe");
    if (!await probe(temporaryGit)) throw new Error("MinGit archive does not contain a runnable cmd/git.exe");
    await rm(outputDir, { recursive: true, force: true });
    await rename(temporaryOutput, outputDir);
  } catch (error) {
    await rm(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
  return "prepared";
}

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function hasExpectedHash(filePath, expected) {
  try { return await sha256File(filePath) === expected; } catch { return false; }
}

async function downloadFile(url, destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`MinGit download failed: ${response.status} ${response.statusText}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("MinGit download timed out after 120 seconds");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeGit(command) {
  try {
    await execFileAsync(command, ["--version"], { windowsHide: true, timeout: 3_000 });
    return true;
  } catch { return false; }
}

async function fileExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "vendor", "mingit-manifest.json"), "utf8"));
  const result = await prepareMinGit({
    manifest,
    cacheDir: path.join(projectRoot, ".cache", "mingit"),
    outputDir: path.join(projectRoot, "resources", "mingit"),
  });
  console.log(`[MinGit] ${result}: ${manifest.version}`);
}
