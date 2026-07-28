import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_HELPER_BYTES = 64 * 1024;

export async function verifyScreenshotHelper(inputPath) {
  const helperPath = path.resolve(inputPath);
  const metadata = await stat(helperPath);
  if (!metadata.isFile()) {
    throw new Error(`Screenshot helper is not a file: ${helperPath}`);
  }
  if (metadata.size <= MIN_HELPER_BYTES) {
    throw new Error(
      `Screenshot helper is too small (${metadata.size} bytes): ${helperPath}`,
    );
  }

  const file = await open(helperPath, "r");
  try {
    const signature = Buffer.alloc(2);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || signature.toString("ascii") !== "MZ") {
      throw new Error(`Screenshot helper is not a Windows executable: ${helperPath}`);
    }
  } finally {
    await file.close();
  }

  return { helperPath, size: metadata.size };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error(
      "Usage: node scripts/verify-screenshot-helper.mjs <path-to-helper.exe>",
    );
  }
  const result = await verifyScreenshotHelper(inputPath);
  console.log(
    `[screenshot-helper] verified ${result.helperPath} (${result.size} bytes)`,
  );
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[screenshot-helper] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
