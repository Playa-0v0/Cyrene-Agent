import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export type ShellKind = "cmd" | "bash";

export interface ResolvedShellExecutable {
  kind: ShellKind;
  executable: string;
}

export function buildDirectShellInvocation(
  shell: ResolvedShellExecutable,
  command: string,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (shell.kind === "bash") {
    return {
      command: shell.executable,
      args: ["--noprofile", "--norc", "-lc", command],
      windowsVerbatimArguments: false,
    };
  }
  return {
    command: shell.executable,
    args: ["/d", "/s", "/c", command],
    windowsVerbatimArguments: true,
  };
}

export async function resolveShellExecutable(kind: ShellKind): Promise<ResolvedShellExecutable | null> {
  if (kind === "cmd") {
    return { kind, executable: process.env.ComSpec || "cmd.exe" };
  }

  for (const candidate of collectBashCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    if (await probeBash(candidate)) return { kind, executable: candidate };
  }
  return null;
}

function collectBashCandidates(): string[] {
  const candidates: string[] = [];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (directory) candidates.push(path.join(directory, "bash.exe"));
  }

  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env.LOCALAPPDATA;
  if (programFiles) candidates.push(path.join(programFiles, "Git", "bin", "bash.exe"));
  if (programFilesX86) candidates.push(path.join(programFilesX86, "Git", "bin", "bash.exe"));
  if (localAppData) candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = path.normalize(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function probeBash(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(executable, ["--noprofile", "--norc", "-lc", "printf cyrene-bash-probe"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && stdout === "cyrene-bash-probe"));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish(false);
    }, 3_000);
  });
}
