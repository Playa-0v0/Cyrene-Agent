import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMinGit } from "./prepare-mingit.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("rejects a downloaded archive with the wrong sha256", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mingit-test-"));
  try {
    await assert.rejects(
      prepareMinGit({
        manifest: { assetName: "mingit.zip", url: "https://example.test/mingit.zip", sha256: "0".repeat(64) },
        cacheDir: path.join(root, "cache"),
        outputDir: path.join(root, "resources", "mingit"),
        download: async (_url, destination) => writeFile(destination, "bad archive"),
        extract: async () => undefined,
        probe: async () => true,
      }),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses a verified extracted git executable without downloading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mingit-test-"));
  try {
    const outputDir = path.join(root, "resources", "mingit");
    await mkdir(path.join(outputDir, "cmd"), { recursive: true });
    await writeFile(path.join(outputDir, "cmd", "git.exe"), "fake");
    let downloaded = false;
    const result = await prepareMinGit({
      manifest: { assetName: "mingit.zip", url: "https://example.test/mingit.zip", sha256: hash("archive") },
      cacheDir: path.join(root, "cache"),
      outputDir,
      download: async () => { downloaded = true; },
      extract: async () => undefined,
      probe: async () => true,
    });

    assert.equal(result, "cached");
    assert.equal(downloaded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
