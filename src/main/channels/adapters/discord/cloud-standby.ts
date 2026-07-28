import { execFile } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import type { DiscordChannelConfig } from "../../settings-store";

export type CloudStandbyAction = "online" | "offline" | "restart" | "status";

export type CloudStandbyStatus = {
  reachable: boolean;
  cloudService: "active" | "inactive" | "activating" | "failed" | "unknown";
  watchdog: "active" | "inactive" | "failed" | "unknown";
  heartbeatAge: number | null;
};

export function cloudStandbySshArgs(config: DiscordChannelConfig, action: CloudStandbyAction): string[] {
  const host = config.cloudStandbyHost?.trim();
  const user = config.cloudStandbyUser?.trim();
  const configuredKey = config.cloudStandbyKeyPath?.trim();
  if (!host || !user || !configuredKey) throw new Error("雲端備援 SSH 設定不完整");
  const keyPath = configuredKey === "~"
    ? homedir()
    : configuredKey.startsWith("~/")
      ? path.join(homedir(), configuredKey.slice(2))
      : configuredKey;
  const script = action === "online"
    ? "/usr/local/sbin/cyrene-local-online"
    : action === "offline"
      ? "/usr/local/sbin/cyrene-local-offline"
      : action === "restart"
        ? "/usr/local/sbin/cyrene-cloud-restart"
        : "/usr/local/sbin/cyrene-cloud-status";
  return [
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=yes",
    `${user}@${host}`,
    ...(action === "status" ? [script] : ["sudo", script]),
  ];
}

async function runCloudStandby(config: DiscordChannelConfig, action: CloudStandbyAction): Promise<string> {
  const args = cloudStandbySshArgs(config, action);
  return await new Promise<string>((resolve, reject) => {
    execFile("ssh", args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export async function signalCloudStandby(config: DiscordChannelConfig, action: Exclude<CloudStandbyAction, "status">): Promise<void> {
  await runCloudStandby(config, action);
}

export async function queryCloudStandby(config: DiscordChannelConfig): Promise<CloudStandbyStatus> {
  const output = await runCloudStandby(config, "status");
  const parsed = JSON.parse(output) as Partial<CloudStandbyStatus>;
  return {
    reachable: true,
    cloudService: ["active", "inactive", "activating", "failed"].includes(parsed.cloudService ?? "")
      ? parsed.cloudService as CloudStandbyStatus["cloudService"]
      : "unknown",
    watchdog: ["active", "inactive", "failed"].includes(parsed.watchdog ?? "")
      ? parsed.watchdog as CloudStandbyStatus["watchdog"]
      : "unknown",
    heartbeatAge: typeof parsed.heartbeatAge === "number" && Number.isFinite(parsed.heartbeatAge) && parsed.heartbeatAge >= 0
      ? parsed.heartbeatAge
      : null,
  };
}
