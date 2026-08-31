import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Resolve the Electron executable to use for `cyrene run`.
 *
 * Prefer the project's local node_modules/.bin entry so the command works even
 * when `electron` is not on the user's PATH. Fall back to CYRENE_ELECTRON_BIN
 * or the bare `electron` command.
 */
export function resolveElectron(projectRoot: string): string {
  const binName = process.platform === "win32" ? "electron.cmd" : "electron";
  const localBin = path.join(projectRoot, "node_modules", ".bin", binName);
  if (existsSync(localBin)) return localBin;

  return process.env.CYRENE_ELECTRON_BIN ?? "electron";
}
