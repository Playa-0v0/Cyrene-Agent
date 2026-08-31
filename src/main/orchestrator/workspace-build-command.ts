import * as fs from "fs";
import * as path from "path";
import { detect, resolveCommand, type Agent } from "package-manager-detector";

export type WorkspaceBuildCommandResult =
  | {
      ok: true;
      command: string;
      args: string[];
      agent: Agent;
    }
  | {
      ok: false;
      errorCode: "PACKAGE_JSON_NOT_FOUND" | "PACKAGE_JSON_INVALID" | "PACKAGE_SCRIPT_NOT_FOUND" | "PACKAGE_MANAGER_UNSUPPORTED";
      error: string;
    };

export async function resolveWorkspaceBuildCommand(cwd: string): Promise<WorkspaceBuildCommandResult> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return {
      ok: false,
      errorCode: "PACKAGE_JSON_NOT_FOUND",
      error: `工作区未找到 package.json: ${packageJsonPath}`,
    };
  }

  let packageJson: { scripts?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return {
      ok: false,
      errorCode: "PACKAGE_JSON_INVALID",
      error: `工作区 package.json 无法解析: ${packageJsonPath}`,
    };
  }

  if (typeof packageJson.scripts?.build !== "string" || !packageJson.scripts.build.trim()) {
    return {
      ok: false,
      errorCode: "PACKAGE_SCRIPT_NOT_FOUND",
      error: `工作区 package.json 未定义 scripts.build: ${packageJsonPath}`,
    };
  }

  const detected = await detect({ cwd, stopDir: cwd });
  const agent: Agent = detected?.agent ?? "npm";
  const resolved = resolveCommand(agent, "run", ["build"]);
  if (!resolved) {
    return {
      ok: false,
      errorCode: "PACKAGE_MANAGER_UNSUPPORTED",
      error: `检测到的包管理器不支持运行 build 脚本: ${agent}`,
    };
  }

  return {
    ok: true,
    command: resolved.command,
    args: resolved.args,
    agent,
  };
}
