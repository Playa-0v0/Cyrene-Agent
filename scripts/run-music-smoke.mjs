#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const entry = path.join(repoRoot, "dist", "main", "main", "music", "music-smoke-entry.js");
if (!fs.existsSync(entry)) {
  console.error(`[music-smoke-runner] compiled entry not found: ${entry}`);
  console.error("[music-smoke-runner] run 'npm run build:main' first");
  process.exit(1);
}

const child = spawn(electronPath, [entry], {
  env: { ...process.env, CYRENE_MUSIC_SMOKE: "1" },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));