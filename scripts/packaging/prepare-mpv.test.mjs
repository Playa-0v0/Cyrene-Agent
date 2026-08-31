import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMpv } from "./prepare-mpv.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("rejects a downloaded archive with the wrong sha256", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mpv-test-"));
  try {
    await assert.rejects(
      prepareMpv({
        manifest: {
          assetName: "mpv.7z",
          url: "https://example.test/mpv.7z",
          sha256: "0".repeat(64),
          binaryPath: "mpv.exe",
        },
        cacheDir: path.join(root, "cache"),
        outputDir: path.join(root, "resources", "bin", "mpv"),
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

test("reuses a verified extracted mpv executable without downloading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mpv-test-"));
  try {
    const outputDir = path.join(root, "resources", "bin", "mpv");
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "mpv.exe"), "fake");
    let downloaded = false;
    const result = await prepareMpv({
      manifest: {
        assetName: "mpv.7z",
        url: "https://example.test/mpv.7z",
        sha256: hash("archive"),
        binaryPath: "mpv.exe",
      },
      cacheDir: path.join(root, "cache"),
      outputDir,
      download: async () => {
        downloaded = true;
      },
      extract: async () => undefined,
      probe: async () => true,
    });

    assert.equal(result, "cached");
    assert.equal(downloaded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("throws when extracted archive does not contain expected binary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-mpv-test-"));
  try {
    await assert.rejects(
      prepareMpv({
        manifest: {
          assetName: "mpv.7z",
          url: "https://example.test/mpv.7z",
          sha256: hash("archive"),
          binaryPath: "mpv.exe",
        },
        cacheDir: path.join(root, "cache"),
        outputDir: path.join(root, "resources", "bin", "mpv"),
        download: async (_url, destination) => writeFile(destination, "archive"),
        extract: async () => undefined,
        probe: async () => false,
      }),
      /未找到 mpv\.exe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
