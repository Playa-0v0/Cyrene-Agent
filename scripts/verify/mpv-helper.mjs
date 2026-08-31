// 验证 mpv.exe 可执行文件：大小 + MZ 头 + （可选）--version 探测。
import { open, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const MIN_MPV_BYTES = 1 * 1024 * 1024; // 1 MB（mpv.exe 至少几十 MB）

export async function verifyMpvHelper(inputPath, { runVersion = true } = {}) {
  const helperPath = path.resolve(inputPath);
  const metadata = await stat(helperPath);
  if (!metadata.isFile()) {
    throw new Error(`mpv is not a file: ${helperPath}`);
  }
  if (metadata.size <= MIN_MPV_BYTES) {
    throw new Error(`mpv is too small (${metadata.size} bytes): ${helperPath}`);
  }

  const file = await open(helperPath, "r");
  try {
    const signature = Buffer.alloc(2);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || signature.toString("ascii") !== "MZ") {
      throw new Error(`mpv is not a Windows executable: ${helperPath}`);
    }
  } finally {
    await file.close();
  }

  if (runVersion) {
    try {
      const { stdout } = await execFileAsync(helperPath, ["--version"], {
        windowsHide: true,
        timeout: 5_000,
      });
      const firstLine = stdout.split(/\r?\n/)[0] ?? "";
      if (!/mpv/i.test(firstLine)) {
        throw new Error(`mpv --version 输出异常：${firstLine}`);
      }
      return { helperPath, size: metadata.size, version: firstLine.trim() };
    } catch (err) {
      throw new Error(`mpv --version 探测失败：${err.message}`);
    }
  }

  return { helperPath, size: metadata.size };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: node scripts/verify/mpv-helper.mjs <path-to-mpv.exe>");
  }
  const result = await verifyMpvHelper(inputPath);
  console.log(
    `[mpv] verified ${result.helperPath} (${result.size} bytes) — ${result.version ?? "no version"}`,
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[mpv] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
