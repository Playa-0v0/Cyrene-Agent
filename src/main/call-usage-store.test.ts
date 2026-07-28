import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
}));

describe("daily call usage", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-call-usage-"));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("splits one call at local midnight", async () => {
    const { splitCallIntervalByLocalDay } = await import("./call-usage-store");
    const start = new Date(2026, 6, 26, 23, 59, 30).getTime();
    const end = new Date(2026, 6, 27, 0, 0, 45).getTime();
    expect(splitCallIntervalByLocalDay(start, end)).toEqual([
      { date: "2026-07-26", durationMs: 30_000 },
      { date: "2026-07-27", durationMs: 45_000 },
    ]);
  });

  it("does not double-count overlapping desktop and Discord calls", async () => {
    const usage = await import("./call-usage-store");
    const start = new Date(2026, 6, 26, 20, 0, 0).getTime();
    usage.startCallUsage("desktop", start);
    usage.startCallUsage("discord", start + 10_000);
    usage.stopCallUsage("desktop", start + 20_000);
    usage.stopCallUsage("discord", start + 30_000);

    const today = usage.getCallUsage(1, start + 30_000)[0];
    expect(today.totalMs).toBe(30_000);
    expect(today.desktopMs).toBe(20_000);
    expect(today.discordMs).toBe(20_000);
    expect(today.active).toBe(false);
  });

  it("雲端 Discord 通話會合併到 Discord，且與本機切換時不重複計時", async () => {
    const usage = await import("./call-usage-store");
    const start = new Date(2026, 6, 28, 20, 0, 0).getTime();
    usage.startCallUsage("discord-cloud", start);
    usage.startCallUsage("discord", start + 10_000);
    usage.stopCallUsage("discord-cloud", start + 20_000);
    usage.stopCallUsage("discord", start + 30_000);

    const today = usage.getCallUsage(1, start + 30_000)[0];
    expect(today.totalMs).toBe(30_000);
    expect(today.desktopMs).toBe(0);
    expect(today.discordMs).toBe(30_000);
    expect(today.active).toBe(false);
  });

  it("treats repeated starts and stops as idempotent", async () => {
    const usage = await import("./call-usage-store");
    const start = new Date(2026, 6, 26, 21, 0, 0).getTime();
    usage.startCallUsage("desktop", start);
    usage.startCallUsage("desktop", start + 5_000);
    expect(usage.getCallUsage(1, start + 10_000)[0].active).toBe(true);
    usage.stopCallUsage("desktop", start + 10_000);
    usage.stopCallUsage("desktop", start + 20_000);
    expect(usage.getCallUsage(1, start + 20_000)[0].totalMs).toBe(10_000);
  });
});
