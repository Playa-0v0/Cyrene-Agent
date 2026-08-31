import { describe, expect, it } from "vitest";
import { resolveAppUpdateEntryView } from "./AppUpdateEntry";

describe("resolveAppUpdateEntryView", () => {
  it("stays hidden when there is nothing actionable", () => {
    expect(resolveAppUpdateEntryView({ phase: "idle", currentVersion: "1.1.7" })).toBeNull();
    expect(resolveAppUpdateEntryView({ phase: "checking", currentVersion: "1.1.7" })).toBeNull();
    expect(resolveAppUpdateEntryView({ phase: "not_available", currentVersion: "1.1.7" })).toBeNull();
    expect(resolveAppUpdateEntryView({ phase: "error", currentVersion: "1.1.7", error: "offline" })).toBeNull();
  });

  it("shows the next user action for each visible phase", () => {
    expect(resolveAppUpdateEntryView({
      phase: "available",
      currentVersion: "1.1.7",
      availableVersion: "1.2.0",
    })).toMatchObject({ label: "发现新版本 v1.2.0", action: "download", disabled: false });

    expect(resolveAppUpdateEntryView({
      phase: "downloading",
      currentVersion: "1.1.7",
      percent: 42.4,
    })).toMatchObject({ label: "正在下载 42%", action: null, disabled: true });

    expect(resolveAppUpdateEntryView({
      phase: "downloaded",
      currentVersion: "1.1.7",
      availableVersion: "1.2.0",
      percent: 100,
    })).toMatchObject({ label: "重启并更新", action: "install", disabled: false });
  });
});
