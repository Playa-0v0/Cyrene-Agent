import fs from "node:fs";
import path from "node:path";
import type { LspServerDefinition } from "./types";

export interface ResolvedLspServer {
  definition: LspServerDefinition;
  executablePath: string;
  args: string[];
}

export interface LspDiscoveryOptions {
  PATH?: string;
  PATHEXT?: string;
  platform?: NodeJS.Platform;
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function executableNames(command: string, platform: NodeJS.Platform, pathExt: string | undefined): string[] {
  if (platform !== "win32" || path.extname(command) !== "") return [command];
  const extensions = (pathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

function findExecutable(
  command: string,
  directory: string | undefined,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): string | null {
  if (path.isAbsolute(command)) return isRegularFile(command) ? command : null;
  if (!directory) return null;
  for (const name of executableNames(command, platform, pathExt)) {
    const candidate = path.join(directory, name);
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 按显式绝对路径、工作区 node_modules/.bin、系统 PATH 的固定顺序发现用户已安装的服务。
 * 不会执行任何命令，也不会拼接 shell 字符串。
 */
export function resolveLspServer(
  definition: LspServerDefinition,
  workspaceRoot: string,
  options: LspDiscoveryOptions = {},
): ResolvedLspServer | null {
  const platform = options.platform ?? process.platform;
  const pathExt = options.PATHEXT ?? process.env.PATHEXT;
  const systemPath = options.PATH ?? process.env.PATH ?? "";
  const localBin = path.join(workspaceRoot, "node_modules", ".bin");
  const pathEntries = systemPath.split(path.delimiter).filter(Boolean);

  for (const command of definition.commands) {
    const explicit = findExecutable(command.command, undefined, platform, pathExt);
    if (explicit) return { definition, executablePath: explicit, args: [...command.args] };

    const local = findExecutable(command.command, localBin, platform, pathExt);
    if (local) return { definition, executablePath: local, args: [...command.args] };

    for (const directory of pathEntries) {
      const resolved = findExecutable(command.command, directory, platform, pathExt);
      if (resolved) return { definition, executablePath: resolved, args: [...command.args] };
    }
  }
  return null;
}
