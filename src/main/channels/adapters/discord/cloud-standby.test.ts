import { describe, expect, it } from "vitest";
import { cloudStandbySshArgs } from "./cloud-standby";

describe("Discord local-primary cloud standby", () => {
  const config = {
    enabled: true,
    cloudStandbyHost: "35.202.130.71",
    cloudStandbyUser: "bluearchive6888",
    cloudStandbyKeyPath: "/Users/clark/.ssh/codex_cyrene_gcp",
  };

  it("builds a non-interactive authenticated heartbeat command", () => {
    expect(cloudStandbySshArgs(config, "online")).toEqual([
      "-i", "/Users/clark/.ssh/codex_cyrene_gcp",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=yes",
      "bluearchive6888@35.202.130.71",
      "sudo", "/usr/local/sbin/cyrene-local-online",
    ]);
  });

  it("uses the immediate cloud takeover command while shutting down", () => {
    expect(cloudStandbySshArgs(config, "offline").at(-1)).toBe("/usr/local/sbin/cyrene-local-offline");
  });

  it("reads status without sudo and only restarts through the fixed privileged script", () => {
    expect(cloudStandbySshArgs(config, "status").slice(-1)).toEqual(["/usr/local/sbin/cyrene-cloud-status"]);
    expect(cloudStandbySshArgs(config, "restart").slice(-2)).toEqual(["sudo", "/usr/local/sbin/cyrene-cloud-restart"]);
  });
});
