// 准备 mpv 二进制（仅 Windows）。
//
// 流程：检查 resources/bin/mpv/mpv.exe → 缓存命中则跳过；否则下载 .7z 到
// .cache/mpv/，校验 sha256，用系统 tar（bsdtar，Windows 10+ 自带）解压到
// resources/bin/mpv/。
//
// 与 prepare-mingit 同一模式，但解压改用 tar，避免增加 7zip npm 依赖。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");

/**
 * 解压 .7z 到目标目录。优先系统 tar（bsdtar，支持 7z）；失败则抛错。
 * Windows 10 1803+ 自带 bsdtar；macOS 自带 bsdtar 也支持 7z。
 */
async function extract7z(archive, destination) {
  // 先尝试 tar（跨平台 bsdtar）
  try {
    await execFileAsync("tar", ["-xf", archive, "-C", destination], {
      windowsHide: true,
      timeout: 60_000,
    });
    return;
  } catch (err) {
    throw new Error(`tar 解压失败（${err.message}）。请确认系统 bsdtar 支持 7z；Windows 10 1803+ 自带。`);
  }
}

export async function prepareMpv(options) {
  const { manifest, cacheDir, outputDir } = options;
  const probe = options.probe ?? probeMpv;
  const download = options.download ?? downloadFile;
  const extract = options.extract ?? extract7z;
  const binaryPath = path.join(outputDir, manifest.binaryPath);

  if ((await fileExists(binaryPath)) && (await probe(binaryPath))) return "cached";

  await mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, manifest.assetName);
  if (!(await hasExpectedHash(archive, manifest.sha256))) {
    const partial = `${archive}.partial`;
    await rm(partial, { force: true });
    const urls = [manifest.url, ...(manifest.mirrors ?? [])];
    let lastErr = null;
    let downloaded = false;
    for (const url of urls) {
      try {
        await download(url, partial);
        downloaded = true;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[mpv] 下载失败，尝试下一个源：${err.message}`);
      }
    }
    if (!downloaded) {
      throw new Error(`所有下载源均失败：${lastErr?.message ?? "unknown"}`);
    }
    const actual = await sha256File(partial);
    if (actual !== manifest.sha256) {
      await rm(partial, { force: true });
      throw new Error(
        `mpv SHA-256 mismatch: expected ${manifest.sha256}, received ${actual}`,
      );
    }
    await rm(archive, { force: true });
    await rename(partial, archive);
  }

  const temporaryOutput = `${outputDir}.tmp-${process.pid}`;
  await rm(temporaryOutput, { recursive: true, force: true });
  await mkdir(temporaryOutput, { recursive: true });
  try {
    await extract(archive, temporaryOutput);
    const temporaryBinary = path.join(temporaryOutput, manifest.binaryPath);
    if (!(await fileExists(temporaryBinary))) {
      throw new Error(
        `mpv 压缩包内未找到 ${manifest.binaryPath}（请确认 manifest.binaryPath 与压缩包结构一致）`,
      );
    }
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(path.dirname(binaryPath), { recursive: true });
    // Windows 上 rename 偶发 EPERM（杀毒扫描占用），重试 + fallback 到 cp。
    await renameWithRetry(temporaryOutput, outputDir);
  } catch (error) {
    await rm(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
  return "prepared";
}

async function renameWithRetry(src, dest, retries = 3) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code === "EPERM" || err.code === "EACCES") {
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  // Fallback: copy + rm（rename 始终失败时）
  const { cp } = await import("node:fs/promises");
  await cp(src, dest, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
}

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function hasExpectedHash(filePath, expected) {
  try {
    return (await sha256File(filePath)) === expected;
  } catch {
    return false;
  }
}

async function downloadFile(url, destination) {
  // GitHub release 在国内可能直连超时。Node 自带 fetch (undici) 不读系统代理，
  // 故在 Windows 上改用 PowerShell + System.Net.WebClient（自动走 IE/系统代理），
  // 在 macOS/Linux 改用 curl（读 HTTPS_PROXY 环境变量）。
  const platform = process.platform;
  if (platform === "win32") {
    try {
      await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ProgressPreference='SilentlyContinue'; $c=New-Object System.Net.WebClient; $c.Headers.Add('User-Agent','cyrene-prepare-mpv'); $c.DownloadFile('${url.replace(/'/g, "''")}','${destination.replace(/'/g, "''")}')`,
        ],
        { windowsHide: true, timeout: 180_000 },
      );
      return;
    } catch (err) {
      throw new Error(`WebClient 下载失败：${err.message}`);
    }
  }
  // macOS/Linux：用 curl（读 HTTPS_PROXY 环境变量）
  try {
    await execFileAsync(
      "curl",
      ["-fsSL", "--max-time", "180", "-o", destination, url],
      { timeout: 200_000 },
    );
  } catch (err) {
    throw new Error(`curl 下载失败：${err.message}`);
  }
}

async function probeMpv(command) {
  try {
    await execFileAsync(command, ["--version"], {
      windowsHide: true,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, "vendor", "mpv-manifest.json"), "utf8"),
  );
  const result = await prepareMpv({
    manifest,
    cacheDir: path.join(projectRoot, ".cache", "mpv"),
    outputDir: path.join(projectRoot, "resources", "bin", "mpv"),
  });
  console.log(`[mpv] ${result}: ${manifest.version}`);
}
