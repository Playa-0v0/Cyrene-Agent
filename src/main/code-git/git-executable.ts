import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolvedGitExecutable {
  command: string;
  source: "system" | "bundled";
  version: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveGitExecutableDeps {
  systemCommand: string;
  bundledPath: string;
  probe?: (command: string) => Promise<string | null>;
}

export async function probeGitExecutable(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      windowsHide: true,
      timeout: 3_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGitExecutable(
  deps: ResolveGitExecutableDeps,
): Promise<ResolvedGitExecutable | null> {
  const probe = deps.probe ?? probeGitExecutable;
  const systemVersion = await probe(deps.systemCommand);
  if (systemVersion) {
    return {
      command: deps.systemCommand,
      source: "system",
      version: parseGitVersion(systemVersion),
    };
  }

  const bundledVersion = await probe(deps.bundledPath);
  if (!bundledVersion) return null;

  return {
    command: deps.bundledPath,
    source: "bundled",
    version: parseGitVersion(bundledVersion),
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "NUL",
    },
  };
}

function parseGitVersion(output: string): string {
  const match = output.match(/git version\s+(.+)/i);
  return match?.[1]?.trim() || output.trim();
}
